# ClawSync wire format

Wire-level reference for the four ClawSync packet types of protocol `clawnet/1`:
`GOSSIP` (16), `SYNC_DIGEST` (17), `SYNC_REQUEST` (18) and `SYNC_DELTA` (19). It
implements DESIGN.md section 9 with the changes of section 15 (items 14, 17, 19 and 20)
and is meant to be folded into `PROTOCOL.md`. The code is `src/sync/antientropy.js`
(packets, rounds) and `src/sync/datasets.js` (digests, cursors, summaries).

All four types are link-local: they are exchanged between two directly connected,
authenticated peers and are never forwarded. The packet framing is that of DESIGN.md
section 5:

```
packet = u8 type | u8 flags (0) | u16be headerLen | header (canonical JSON) | body (bytes)
```

Every ClawSync packet has a non-empty body. Decoders are strict: an unknown header field,
a missing field, a value of the wrong type or out of range, or a body that is not exactly
in the form given here is a protocol violation (section 8).

## 1. Common definitions

**Dataset name** (`set`). A string matching `^[a-z][a-z0-9-]{0,31}$`. It names the
dataset a packet is about. A packet carries data for exactly one dataset.

**Key.** LWW keys and log stream ids are strings of 1 to 128 printable ASCII characters
without the space (`^[\x21-\x7e]{1,128}$`). Keys are ordered by byte value. The
restriction to ASCII is what makes that order the same in every implementation.

**Record.** A signed record (DESIGN.md section 3): a JSON object. On the wire a record is
its canonical JSON encoding (`src/core/wire/canonical.js`), at most `MAX_RECORD` bytes.
A receiver parses it with the strict canonical parser, so a record has exactly one
encoding and a relay re-emits the bytes it received.

**Record hash.** `SHA-256(canonical JSON of the record)`, signature included. It is the
tie-break of the total order of LWW records (section 5). A digest carries its first 8
bytes as 16 lowercase hex characters (`^[0-9a-f]{16}$`), written `h(record)` below.

**Record batch** (body of `GOSSIP` and `SYNC_DELTA`):

```
batch  = record-frame{n}
record-frame = u32be length | record (canonical JSON, `length` bytes)
```

`n` is given in the header, `1 <= n <= MAX_ITEMS`. Each `length` is in `2..MAX_RECORD`.
The frames must fill the body exactly: fewer than `n` frames, a frame that runs past the
end, or bytes after the last frame are violations.

**List** (body of `SYNC_DIGEST` and `SYNC_REQUEST`): one canonical JSON array with at most
`MAX_ITEMS` elements. An empty list is the two bytes `[]`.

**Limits.**

| Name | Value | Meaning |
| --- | --- | --- |
| `MAX_ITEMS` | 1024 | records per batch, entries per digest page, items per request |
| `MAX_RECORD` | 65536 | bytes of one record |
| `MAX_BODY` | 1040380 | bytes of a body: `MAX_PACKET - 4 - MAX_HEADER` |
| `MAX_RANGES` | 32 | out-of-order ranges in one log digest entry of a page |

These are what a receiver accepts. A sender may use smaller batches (the engine's
`limits.maxRecordsPerPacket`, default 256, and `limits.maxBytesPerPacket`, default
262144, which is never below `MAX_RECORD + 4` so that any record fits in a batch).

**Cursor.** A position in a dataset's total order. Everything at or before a cursor has
been dealt with.

| Dataset kind | Cursor | Order |
| --- | --- | --- |
| LWW | a key | byte order of the key |
| Log | `[stream, index]`, `index` an integer in `0..2^53-1` | by stream, then by index |

For a log, `[stream, 2^53-1]` covers the whole stream. In a header, `null` in place of a
cursor means "the start" (`after`), "the end of the dataset" (`upto`) or "the whole
page" (`next`).

**Summary.** `SHA-256` of the canonical JSON list of every digest entry of a dataset, in
ascending order, as 64 lowercase hex characters (`^[0-9a-f]{64}$`):

- LWW: every record entry and every tombstone entry (section 5), exactly what the pages
  of a whole round would list;
- log: one entry per stream listing all of its ranges, with no `MAX_RANGES` cut and so
  never the trailing newest index (section 5).

Two nodes with the same summary for a dataset hold the same entries and have nothing to
exchange for it.

## 2. GOSSIP (16) and SYNC_DELTA (19)

Both carry records for one dataset and are processed identically. `GOSSIP` is the eager
push of records the sender has just accepted; `SYNC_DELTA` carries records sent during an
anti-entropy round.

Header:

```json
{ "n": 3, "set": "lsa" }
```

| Field | Type | |
| --- | --- | --- |
| `n` | integer, `1..MAX_ITEMS` | number of records in the body |
| `set` | dataset name | |

Body: a record batch of `n` records.

Receiver, for each record in order:

1. If the record has a string `origin` that the node's origin policy (blocklist,
   allowlist) refuses, drop it silently.
2. If its key (LWW) or stream (log) is unknown here, it spends one unit of the sending
   peer's new-key budget (`newKeysPerMinute`, default 10000, refilled continuously). With
   the budget spent, drop it silently; a later round brings it again.
3. Offer it to the dataset. The dataset first applies its cheap tests (where it stands
   in the total order, whether the index is held or pruned, whether there is room) and
   only then the full validation including the signature.

Steps 1 and 2 cost no signature verification, and neither is a violation: the relaying
peer may run another policy, or be passing on someone else's burst. Then:

- stored (new, or later in the total order than what was held): queue it for `GOSSIP` to
  every peer except the one it came from, subject to the hold-down below;
- old, duplicate, pruned, not storable here, or a valid record that loses an equal-version
  tie: drop it silently. It is **not** forwarded, which is what ends a flood;
- malformed or failing validation: drop it, stop processing the packet, report the peer
  (`invalid-record`). Records earlier in the same packet were valid and stay.

A packet for a dataset the receiver does not run is ignored without error.

Sender: records accepted are batched for `gossipBatchMs` (default 25 ms), then sent as one
or more `GOSSIP` packets per dataset per peer, in the order they were accepted. At most
`maxPendingPerPeer` records wait per peer; beyond that they are dropped and left to
anti-entropy.

**Hold-down** (DESIGN.md section 15, item 17; configured per dataset, 5 s for LSAs). Every
record is stored as soon as it is accepted, but per key at most one record is flooded per
interval. A record accepted while its key's interval runs waits, replacing any record of
that key already waiting; when the interval ends the waiting record (always the newest)
is flooded and a new interval starts. A key with nothing waiting at the end of its
interval is forgotten. This changes how often records are sent, not what is sent.

## 3. SYNC_DIGEST (17)

Sent only by the initiator of a round. It is one of two things.

**A summary** opens each dataset of a round:

```json
{ "round": 7, "set": "peer", "sum": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" }
```

| Field | Type | |
| --- | --- | --- |
| `round` | integer `>= 1` | chosen by the initiator, larger for each new round on a link |
| `set` | dataset name | |
| `sum` | summary (section 1) | the initiator's summary of this dataset |

Body: the empty list `[]`. A summary has no `after`, `upto` or `hint`.

**A page** of the sender's digest of one dataset:

```json
{ "after": null, "hint": { "min": 41 }, "round": 7, "set": "peer", "upto": "mfrggzdf..." }
```

| Field | Type | |
| --- | --- | --- |
| `after` | cursor or `null` | the page covers everything strictly after this position |
| `upto` | cursor or `null` | ... up to and including this position; `null`: to the end |
| `round`, `set` | | as for a summary |
| `hint` | object, optional | what the sender can still accept (section 5); for a log dataset it is mandatory |

If both are given, `after` must be strictly before `upto`. For a log, `upto` is a
whole-stream cursor `[stream, 2^53-1]`, except when the page's last entry is cut at
`MAX_RANGES` ranges (section 5): then `upto` is `[stream, i]` with `i` the end of the
last range listed, and the next page restarts inside that stream.

Body: a list of digest entries (section 5), in ascending order, all inside the page.

The page is a complete statement about its range: the sender holds exactly the listed
entries there and nothing else. That is what lets the receiver treat each page on its
own, without remembering earlier ones. The first entry after `after` is always included,
whatever the size limits, so paging always advances.

## 4. SYNC_REQUEST (18)

The responder's answer to one `SYNC_DIGEST`. Exactly one `SYNC_REQUEST` is sent per
`SYNC_DIGEST`, after the `SYNC_DELTA` (if any) that belongs to the same page.

Header:

```json
{ "next": null, "round": 7, "set": "peer" }
```

| Field | Type | |
| --- | --- | --- |
| `round`, `set` | | copied from the digest being answered |
| `next` | cursor or `null` | answer to a page: `null` if the whole page was processed; a cursor if the page was processed up to and including it, and the initiator continues from there. Must be strictly after the page's `after` and not after its `upto`. Answer to a summary: always `null`. |
| `stop` | `"same"`, `"set"` or `"round"`, optional | `"same"`: only in answer to a summary, which equals the responder's own; the dataset is done. `"set"`: skip the rest of this dataset (the responder does not run it). `"round"`: end the round (the responder declines it). With `stop`, `next` is `null` and the body is `[]`. |

Answer to a summary: `stop: "same"` if the responder's summary of the dataset is the one
received, `stop: "set"` or `"round"` as above, and otherwise a request with `next: null`
and body `[]`, which tells the initiator to send its pages.

Answer to a page. Body: a list of request items, in ascending order, each at or before
`next`:

| Dataset kind | Item | Constraint |
| --- | --- | --- |
| LWW | a key | must be a key the page listed as a record (not as a tombstone) |
| Log | `[stream, from, to]`, inclusive, `1 <= from <= to` | `stream` must be listed in the page, and the range must lie inside what the entry advertised: `from > floor` and `to <=` the end of the entry's last listed range (or `high` without ranges). If the page restarted inside the stream (`after = [stream, i]`), `from > i`. Ranges of one stream must not overlap. |

A request can therefore never name anything the initiator did not offer in that page,
and its size is bounded by the page. Within a range the initiator sends the indices it
still holds; items that have disappeared since the page was built are skipped.

## 5. Digest entries and hints

### LWW datasets

Records of one key are totally ordered (DESIGN.md section 15, item 14): the higher
version comes later, and at an equal version the record with the greater record hash
comes later. A node keeps the latest record it has seen and floods a record that comes
later than the one it held, including one that wins an equal-version tie. Two valid
records of one key with one version are equivocation by their origin; nodes report it.

Entry: `[key, version, h(record)]` for a record the sender holds, or `[key, version, 1]`
for a *tombstone*: the sender removed its record at that version and does not want that
version or an older one again. `version` is an integer in `0..2^53-1`.

Hint: `{ "min": version }`, present only when the sender is at capacity. It can then
accept a record for a key it does not hold only if the record's version is greater than
`min` (a node that ranks keys by priority may take some others too; the hint is advice,
the dataset decides). Without capacity pressure the hint is omitted.

The receiver of a page compares it with its own state, key by key in ascending order,
records by `(version, hash prefix)`:

| Sender's entry | Receiver holds | Action |
| --- | --- | --- |
| none | a record | push it (if `min` is given: only if its version `> min`) |
| `[k, v, h]` | a record later than `(v, h)` | push it |
| `[k, v, h]` | a record earlier than `(v, h)` | want `k` |
| `[k, v, h]` | a record equal to `(v, h)` | nothing |
| `[k, v, h]` | nothing, or a tombstone below `v` | want `k` (at capacity: only if it would be kept) |
| `[k, v, h]` | a tombstone at or above `v` | nothing |
| `[k, v, 1]` | a record with version `> v` | push it |
| `[k, v, 1]` | anything else | nothing |

Two different records whose hashes share their first 8 bytes compare as equal here; with
SHA-256 that needs a deliberate 64-bit collision by the origin itself, and only delays
convergence of that one key until its next version.

### Log datasets

Entry: `[stream, floor, high]`, `[stream, floor, high, ranges]` or
`[stream, floor, high, ranges, top]`.

- `floor`: indices at or below it are pruned. The sender does not hold them and will not
  accept them.
- `high >= floor`: the sender holds every index in `(floor, high]`.
- `ranges`: present only if non-empty, 1 to `MAX_RANGES` pairs `[from, to]` (inclusive):
  what the sender holds above `high`, ascending, each range separated from `high` and
  from the previous range by at least one missing index.
- `top`: present only if the sender holds more ranges than it listed. It is the newest
  index the sender holds in the stream, greater than the end of the last range listed.
  Such an entry is the last of its page, and the page ends inside the stream at the end
  of the last range listed (`upto = [stream, end]`); the next page restarts there and
  lists the following ranges. A page is therefore always a complete statement about its
  range, however fragmented a stream is.

When a page restarts inside a stream (`after = [stream, i]`), that stream's entry lists
only ranges above `i`. A complete digest (as hashed into a summary) lists every range of
every stream and never carries `top`.

Hint: `{ "win": n }` and optionally `"full": true`.

- `win >= 1` is the sender's retention window: it keeps only the `win` indices ending at
  the newest index it knows in a stream.
- `full` says the sender cannot track another stream.

The receiver of a page, per stream in ascending order (streams it holds that the page
does not list count as an entry `[stream, 0, 0]`), with `newest` the highest index
either side holds (the sender's `top`, or the end of its last range, or `high`):

- *push* each index it holds that the sender does not hold and will keep: above the
  sender's `floor`, above `newest - win`, and not in `(floor, high]` or a range. Nothing
  is pushed for an unlisted stream if `full` is set.
- *want*, as ranges, each index the sender holds that the receiver lacks and will keep:
  above the receiver's own floor and above `newest` minus the receiver's own window. A
  receiver that cannot track another stream wants nothing from a stream it does not have
  (unless it ranks that stream above one it would give up).

Inside the stream of a restart cursor `after = [stream, i]`, only indices above `i` are
considered; inside the stream of an end cursor `upto = [stream, j]`, only indices up to
`j`. Pushes and wants of one stream are ordered by index.

Floors are why pruning is stable: an index at or below a floor is never requested by the
node that pruned it and never offered to it, however many rounds run.

## 6. A round

A round is started by one node (the *initiator*) on link-up and then every sync interval
with a random peer; it is push-pull, so one round reconciles both sides. It walks the
datasets one after the other. For each dataset it first sends its summary; if the
responder's summary is the same the dataset is done (DESIGN.md section 15, item 20).
Otherwise it walks its digest from the start to the end. It is stop-and-wait: one packet
is outstanding at a time.

```
initiator                                      responder
    | SYNC_DIGEST  set, round, sum                   |
    |----------------------------------------------->|   compare with own summary
    |                 SYNC_REQUEST  stop "same"  ... dataset done, next dataset
    |<-----------------------------------------------|
    |   or            SYNC_REQUEST  next null, []  ... go on:
    |<-----------------------------------------------|
    | SYNC_DIGEST  set, round, after, upto, entries  |
    |----------------------------------------------->|   compare the page with own state
    |                 SYNC_DELTA  records the initiator lacks   (omitted if none)
    |<-----------------------------------------------|
    |                 SYNC_REQUEST  wants, next
    |<-----------------------------------------------|
    | SYNC_DELTA  the wanted records  (omitted if none)
    |----------------------------------------------->|
    | SYNC_DIGEST  the next page ...                 |
    |----------------------------------------------->|
```

Between two converged nodes a round therefore costs one summary and one answer per
dataset, whatever the size of the datasets.

**Responder.** It keeps no copy of the page. It walks the page and its own state in
cursor order, collecting records to push into one `SYNC_DELTA` and items into one
`SYNC_REQUEST`, and stops when either is full. `next` is the cursor of the last position
it completed, or `null` if it completed the page.

**Initiator.** On the `SYNC_REQUEST` for its outstanding page it sends the wanted
records in one `SYNC_DELTA`. Then it continues with a new page whose `after` is

- the cursor of the last record it sent, if not all wanted records fitted in the packet;
- otherwise `next`, if the responder gave one;
- otherwise the page's `upto`; if that was `null` the dataset is done and the next one
  starts with its summary.

Because a new page restates the initiator's digest for the part not yet completed, and
both sides have by then stored what was exchanged, the responder recomputes exactly what
is still missing. Nothing has to be remembered across packets except the initiator's
cursor, and a difference of any size is worked off in packets of bounded size.

**Rules that bound a round.**

- Within one round a responder pushes each position at most once: it remembers, per
  dataset, the furthest cursor it has covered and never pushes at or before it again.
  Replaying a digest yields a `SYNC_REQUEST` and no records.
- A responder serves one round per peer at a time, identified by `round`. A digest
  (summary or page) with a lower `round` is ignored. A higher `round` starts a new round,
  unless the previous one started less than `minRoundIntervalMs` (default 1000 ms) ago;
  then it is declined with `stop: "round"`.
- An initiator accepts a `SYNC_REQUEST` only for its outstanding summary or page (same
  `round` and `set`); anything else is ignored as stale. Its cursor advances with every
  page, so each record is served at most once per round.
- An initiator sends at most `maxRoundSteps` (default 4096) digests per round, summaries
  and pages counted alike; a round that needs more ends there and the next round
  continues the work. Pages shrink (down to 8 entries) while the responder completes only
  a small part of each, and grow back when pages are completed whole.
- A round with no reply for `roundTimeoutMs` (default 10 s, on the monotonic clock) is
  abandoned by the initiator. There are no retransmissions; the next round starts from
  the beginning with a new `round`.

**Who starts.** Both ends may start a round on link-up. An implementation that knows its
own node id lets only the end with the smaller id start it (ids compared as strings in
byte order), which avoids sending the same difference twice. Either behaviour is
correct, and concurrent rounds in both directions are independent.

## 7. Example

Node A holds LWW records `a@3`, `c@5`, `d@1`. Node B holds `b@2`, `c@4`, `d@1` (the same
record as A's) and has removed `a` at version 3. A starts round 7. `h(x)` stands for the
16 hex characters of record `x`'s hash.

```
A -> B  SYNC_DIGEST  {"round":7,"set":"kv","sum":"<summary of A's kv>"}      []
B -> A  SYNC_REQUEST {"next":null,"round":7,"set":"kv"}                      []
A -> B  SYNC_DIGEST  {"after":null,"round":7,"set":"kv","upto":null}
                     [["a",3,"h(a@3)"],["c",5,"h(c@5)"],["d",1,"h(d@1)"]]
B -> A  SYNC_DELTA   {"n":1,"set":"kv"}                                      record b@2
B -> A  SYNC_REQUEST {"next":null,"round":7,"set":"kv"}                      ["c"]
A -> B  SYNC_DELTA   {"n":1,"set":"kv"}                                      record c@5
```

The summaries differ, so B answers "go on". B does not ask for `a`: its floor for `a` is
3. In a later round started by B, its digest lists `["a",3,1]`, and A does not push
`a@3`. Once both hold the same entries, the next round's summaries match and B answers
the summary with `{"next":null,"round":8,"set":"kv","stop":"same"}`.

## 8. Violations

A receiver that detects one of these drops the packet (or the rest of it), abandons the
round it runs with that peer, and reports the peer to its owner, which disconnects it.
The reason strings are stable; they are safe to log and to send in a `BYE`.

| Reason | Raised for |
| --- | --- |
| `bad-header` | missing, unknown or malformed header field; `n` out of range; malformed dataset name; `round < 1`; a summary whose `sum` is not 64 lowercase hex characters, or that also carries `after`, `upto` or `hint`; a `stop` with a continuation or a request; an answer to a summary that carries a continuation or a request; `stop: "same"` in answer to a page; unknown `stop` value |
| `bad-body` | no body, body over `MAX_BODY`, record batch that does not hold exactly `n` frames, frame length outside `2..MAX_RECORD` |
| `bad-record` | a record that is not canonical JSON |
| `invalid-record` | a record that is not an object, has a malformed key, version, stream or index, or fails the dataset's validation (bad signature, wrong type, ...) |
| `bad-digest` | digest body that is not a canonical JSON list, has more than `MAX_ITEMS` entries, a malformed entry (an LWW record entry without a 16-hex-character hash, a log entry with more than `MAX_RANGES` ranges or a `top` not above its last range), entries out of order or outside the page; a summary whose body is not `[]` |
| `bad-hint` | `hint` that is not an object, has an unknown field or a malformed value, or is missing where it is mandatory |
| `bad-cursor` | malformed cursor, `after` not before `upto`, a `next` that does not advance or lies beyond the page |
| `bad-request` | request body that is not a canonical JSON list, has more than `MAX_ITEMS` items, a malformed item, items out of order or overlapping |
| `bad-range` | a request for a key or range the page did not advertise, before the page's start, or beyond `next` |

Not violations, and never reported: records that are old, duplicates, pruned, not
storable at the receiver, refused by its origin policy, or over the sender's new-key
budget; a valid record that loses an equal-version tie; packets for a dataset the
receiver does not run; a `SYNC_REQUEST` that matches no outstanding summary or page; a
`SYNC_DIGEST` of a superseded round. A dataset's validator may also mark a refusal as
*soft* (the record is fine but not acceptable here and now, for example expired by the
local clock); such records are dropped without a report.

## 9. What a peer can cost

- **Memory.** A packet is processed as it arrives and nothing of a peer's digest or
  request is retained. Per peer the engine holds a gossip queue of at most
  `maxPendingPerPeer` record references, one outstanding summary or page of its own
  digest, one cursor per dataset and a new-key budget. Hold-downs hold at most one
  waiting record per key of their dataset. Stored data is bounded by the datasets' own
  limits and admitted only after validation.
- **Bandwidth.** Each packet received triggers at most two packets in reply. As
  responder a node sends each of its records at most once per round and serves at most
  one round per peer per `minRoundIntervalMs`. As initiator it sends each record at most
  once per round, only on request and only what it advertised, and at most
  `maxRoundSteps` digests, whose pages shrink for a peer that does not use them. Between
  converged nodes a round is one summary and one answer per dataset. With a hold-down a
  key is flooded at most once per interval.
- **Computation.** List sizes are checked before a list is walked. A record from a
  refused origin, a record over the new-key budget, and a record that is old or a
  duplicate are rejected before any signature is verified, and the first invalid record
  ends the processing of its packet. A peer can make this node verify at most
  `newKeysPerMinute` records of unknown keys per minute. Summaries are cached until the
  dataset changes. Ranges are bounded by what was advertised, not by the numbers in
  them; ranges and already covered ground are stepped over, not walked.

Not bounded here: the rate at which a peer may send packets. That is the transport's
token bucket (DESIGN.md section 5).
