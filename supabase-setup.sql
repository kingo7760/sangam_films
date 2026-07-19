-- Run this once in your Supabase project's SQL Editor
-- (Dashboard → SQL Editor → New query → paste → Run)

create table if not exists gallery_items (
  id           text primary key,
  type         text not null,          -- 'photo' | 'video'
  category     text not null,
  caption      text default '',
  url          text,                   -- public URL (Supabase Storage or external link)
  storage_key  text,                   -- set only for uploaded files; used for deletion
  created_at   timestamptz default now()
);

-- Let anyone read gallery items (public gallery)
alter table gallery_items enable row level security;

create policy "Public read"
  on gallery_items for select
  using (true);

-- Only the service-role key (used by your backend) can write
-- No extra policy needed — service-role bypasses RLS by default
