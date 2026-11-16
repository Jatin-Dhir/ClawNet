import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LinkMetric,
  MAX_LINK_COST,
  ADVERTISE_RATIO,
  ADVERTISE_DELTA_MS,
} from '../../src/core/routing/metric.js';
import { ConfigError } from '../../src/core/errors.js';

/** A metric whose cost is exactly `cost`: with alpha 1 the average is the last sample. */
function metricAt(cost) {
  const metric = new LinkMetric({ alpha: 1 });
  metric.sample(cost);
  assert.equal(metric.cost, cost);
  return metric;
}

test('the documented thresholds are 25 percent and 10 ms, and the cost range is 16 bit', () => {
  assert.equal(ADVERTISE_RATIO, 0.25);
  assert.equal(ADVERTISE_DELTA_MS, 10);
  assert.equal(MAX_LINK_COST, 65535);
});

test('an unmeasured link has no srtt and the worst cost', () => {
  const metric = new LinkMetric();
  assert.equal(metric.srtt, null);
  assert.equal(metric.misses, 0);
  assert.equal(metric.cost, 65535);
});

test('the first sample becomes the srtt, later samples are smoothed with alpha', () => {
  const metric = new LinkMetric();
  metric.sample(100);
  assert.equal(metric.srtt, 100);
  assert.equal(metric.cost, 100);

  // 100 + 0.125 * (200 - 100)
  metric.sample(200);
  assert.equal(metric.srtt, 112.5);
  assert.equal(metric.cost, 113);

  // 112.5 + 0.125 * (12.5 - 112.5)
  metric.sample(12.5);
  assert.equal(metric.srtt, 100);
  assert.equal(metric.cost, 100);
});

test('a custom alpha changes how fast the average follows', () => {
  const metric = new LinkMetric({ alpha: 0.5 });
  metric.sample(40);
  metric.sample(80);
  assert.equal(metric.srtt, 60);
  metric.sample(20);
  assert.equal(metric.srtt, 40);
});

test('a constant RTT gives exactly that cost however many samples arrive', () => {
  const metric = new LinkMetric();
  for (let i = 0; i < 1000; i += 1) metric.sample(37);
  assert.equal(metric.srtt, 37);
  assert.equal(metric.cost, 37);
});

test('the cost is the srtt rounded up, and never below 1', () => {
  const cases = [
    [0, 1],
    [0.2, 1],
    [1, 1],
    [1.001, 2],
    [10.01, 11],
    [99.999, 100],
  ];
  for (const [rtt, expected] of cases) {
    const metric = new LinkMetric();
    metric.sample(rtt);
    assert.equal(metric.cost, expected, `rtt ${rtt}`);
    assert.ok(Number.isInteger(metric.cost));
  }
});

test('each consecutive miss multiplies the cost and the next sample clears the penalty', () => {
  const metric = new LinkMetric();
  metric.sample(10);
  metric.miss();
  assert.equal(metric.misses, 1);
  assert.equal(metric.cost, 20);
  metric.miss();
  assert.equal(metric.cost, 40);
  metric.miss();
  assert.equal(metric.misses, 3);
  assert.equal(metric.cost, 80);
  // The miss does not touch the average, only the multiplier.
  assert.equal(metric.srtt, 10);

  metric.sample(10);
  assert.equal(metric.misses, 0);
  assert.equal(metric.cost, 10);
});

test('a custom miss penalty is applied per miss and the product is rounded up', () => {
  const metric = new LinkMetric({ missPenalty: 1.5 });
  metric.sample(3);
  metric.miss();
  assert.equal(metric.cost, 5); // 4.5 rounded up
  metric.miss();
  assert.equal(metric.cost, 7); // 6.75 rounded up

  const flat = new LinkMetric({ missPenalty: 1 });
  flat.sample(3);
  flat.miss();
  flat.miss();
  assert.equal(flat.cost, 3);
});

test('the cost saturates at maxCost instead of overflowing', () => {
  const metric = new LinkMetric();
  metric.sample(30000);
  metric.miss();
  assert.equal(metric.cost, 60000);
  metric.miss();
  assert.equal(metric.cost, 65535);

  // 2 ** 5000 is Infinity in IEEE-754; the cost must still be a valid integer.
  for (let i = 0; i < 5000; i += 1) metric.miss();
  assert.equal(metric.cost, 65535);

  const small = new LinkMetric({ maxCost: 100 });
  assert.equal(small.cost, 100);
  small.sample(60);
  assert.equal(small.cost, 60);
  small.miss();
  assert.equal(small.cost, 100);
});

test('misses before the first sample leave the cost at maxCost and are cleared by it', () => {
  const metric = new LinkMetric();
  metric.miss();
  metric.miss();
  assert.equal(metric.misses, 2);
  assert.equal(metric.cost, 65535);
  metric.sample(5);
  assert.equal(metric.misses, 0);
  assert.equal(metric.cost, 5);
});

test('an absurd sample is clamped to maxCost so the average can recover', () => {
  const metric = new LinkMetric();
  metric.sample(1e12);
  assert.equal(metric.srtt, 65535);
  assert.equal(metric.cost, 65535);

  const small = new LinkMetric({ maxCost: 200, alpha: 0.5 });
  small.sample(100);
  small.sample(1e9);
  assert.equal(small.srtt, 150);
});

test('sample rejects values that are not a finite, non-negative number', () => {
  const metric = new LinkMetric();
  metric.sample(50);
  for (const bad of [NaN, Infinity, -Infinity, -1, -0.001, '5', null, undefined, 5n, {}, [5]]) {
    assert.throws(
      () => metric.sample(bad),
      (err) => err instanceof ConfigError && err.code === 'ERR_CONFIG',
      String(bad),
    );
  }
  // A rejected sample changes nothing.
  assert.equal(metric.srtt, 50);
  assert.equal(metric.cost, 50);
});

test('constructor rejects out-of-range options', () => {
  const bad = [
    { alpha: 0 },
    { alpha: -0.1 },
    { alpha: 1.01 },
    { alpha: NaN },
    { alpha: '0.5' },
    { missPenalty: 0.99 },
    { missPenalty: Infinity },
    { missPenalty: NaN },
    { missPenalty: '2' },
    { maxCost: 0 },
    { maxCost: 1.5 },
    { maxCost: 65536 },
    { maxCost: '100' },
  ];
  for (const options of bad) {
    assert.throws(() => new LinkMetric(options), ConfigError, JSON.stringify(options));
  }
  assert.doesNotThrow(() => new LinkMetric({ alpha: 1, missPenalty: 1, maxCost: 1 }));
});

test('shouldAdvertise is true for a link that was never advertised', () => {
  const metric = metricAt(20);
  assert.equal(metric.shouldAdvertise(null), true);
  assert.equal(metric.shouldAdvertise(undefined), true);
  assert.equal(new LinkMetric().shouldAdvertise(), true);
});

test('shouldAdvertise fires only above 25 percent AND above 10 ms, not at the thresholds', () => {
  // DESIGN.md section 15, item 17. [advertised cost, current cost, expected]
  const cases = [
    // Unchanged.
    [100, 100, false],
    [1, 1, false],
    // The 25 % rule decides for expensive links (more than 10 ms is not enough).
    [100, 111, false],
    [100, 125, false],
    [100, 126, true],
    [100, 75, false],
    [100, 74, true],
    [1000, 1011, false],
    [1000, 1250, false],
    [1000, 1251, true],
    [1000, 749, true],
    // The 10 ms rule decides for cheap links (more than 25 % is not enough).
    [8, 11, false],
    [8, 18, false],
    [8, 19, true],
    [20, 30, false],
    [20, 31, true],
    [20, 10, false],
    [20, 9, true],
    // At 40 ms the two thresholds coincide.
    [40, 50, false],
    [40, 51, true],
    [40, 30, false],
    [40, 29, true],
    // At the bottom of the range a step of one or two units is jitter, not news.
    [1, 2, false],
    [2, 1, false],
    [3, 2, false],
    [3, 5, false],
    [1, 11, false],
    [1, 12, true],
  ];
  for (const [advertised, current, expected] of cases) {
    assert.equal(
      metricAt(current).shouldAdvertise(advertised),
      expected,
      `advertised ${advertised}, now ${current}`,
    );
  }
});

test('regression: RTT jitter around 1 ms and 2 ms does not re-advertise the link', () => {
  // Review finding (routing, low): with "25 % OR 10 ms" a LAN link resting near 1.0 or
  // 2.0 ms flipped its integer cost on ordinary jitter, about 1400 times a day. Simulate a
  // day of keepalives (every 10 s) with a seeded Gaussian RTT source and count the LSAs
  // the rule would trigger after the first advertisement.
  let state = 0x5eed;
  const uniform = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return (state + 1) / 2147483649;
  };
  const gaussian = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());

  for (const [mean, spread] of [[1.0, 0.3], [2.0, 0.5], [3.0, 0.6], [20, 2]]) {
    const metric = new LinkMetric();
    metric.sample(mean);
    let advertised = metric.cost;
    let readvertised = 0;
    for (let i = 0; i < 8640; i += 1) {
      metric.sample(Math.max(0, mean + spread * gaussian()));
      if (metric.shouldAdvertise(advertised)) {
        advertised = metric.cost;
        readvertised += 1;
      }
    }
    assert.equal(readvertised, 0, `RTT ${mean} +/- ${spread} ms`);
  }

  // A real change still gets through: the same link degrading to 40 ms.
  const metric = new LinkMetric();
  metric.sample(1);
  const advertised = metric.cost;
  for (let i = 0; i < 40; i += 1) metric.sample(40);
  assert.equal(metric.shouldAdvertise(advertised), true);
});

test('shouldAdvertise reacts to the miss penalty and to its clearing', () => {
  const metric = metricAt(30);
  assert.equal(metric.shouldAdvertise(30), false);
  metric.miss();
  assert.equal(metric.cost, 60);
  assert.equal(metric.shouldAdvertise(30), true);
  assert.equal(metric.shouldAdvertise(60), false);
  metric.sample(30);
  assert.equal(metric.shouldAdvertise(60), true);
});

test('shouldAdvertise rejects an advertised cost that cannot be a cost', () => {
  const metric = metricAt(20);
  for (const bad of [0, -1, NaN, Infinity, '20', {}, false]) {
    assert.throws(() => metric.shouldAdvertise(bad), ConfigError, String(bad));
  }
});
