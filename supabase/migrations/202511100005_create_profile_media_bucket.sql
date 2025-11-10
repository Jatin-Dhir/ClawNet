-- Create storage bucket for profile media if it does not already exist
insert into storage.buckets (id, name, public)
values ('profile-media', 'profile-media', true)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Allow profile media uploads'
  ) then
    create policy "Allow profile media uploads"
    on storage.objects
    for insert
    with check (
      bucket_id = 'profile-media'
      and auth.role() = 'authenticated'
      and auth.uid() = owner
    );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Allow profile media updates'
  ) then
    create policy "Allow profile media updates"
    on storage.objects
    for update
    using (
      bucket_id = 'profile-media'
      and auth.role() = 'authenticated'
      and auth.uid() = owner
    )
    with check (
      bucket_id = 'profile-media'
      and auth.role() = 'authenticated'
      and auth.uid() = owner
    );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Allow profile media deletes'
  ) then
    create policy "Allow profile media deletes"
    on storage.objects
    for delete
    using (
      bucket_id = 'profile-media'
      and auth.role() = 'authenticated'
      and auth.uid() = owner
    );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Allow profile media read access'
  ) then
    create policy "Allow profile media read access"
    on storage.objects
    for select
    using (bucket_id = 'profile-media');
  end if;
end $$;

