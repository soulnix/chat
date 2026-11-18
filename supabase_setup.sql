-- =========================================================
-- SoulNix Chat — Supabase setup script
-- Paste this whole file into the Supabase SQL Editor and
-- click "Run". It is safe to re-run (uses IF NOT EXISTS /
-- DROP ... IF EXISTS guards).
-- =========================================================

-- ---------------------------------------------------------
-- 1. PROFILES
-- One row per account. Holds the public identity info
-- needed for end-to-end encryption. The private key never
-- leaves this table in a form the server can read: it is
-- encrypted client-side with a key derived from the user's
-- passphrase before it is ever uploaded.
-- ---------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  public_key jsonb not null,              -- ECDH public key (JWK), safe to be public
  encrypted_private_key text not null,     -- AES-GCM ciphertext of the private key
  private_key_iv text not null,            -- IV used for that encryption
  kdf_salt text not null,                  -- salt used to derive the passphrase key (PBKDF2)
  retain_messages boolean not null default false, -- true = disable this user's auto-delete preference
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.profiles add column if not exists avatar_url text;

-- Presence for the chat list ("online" / "last online ..."). Clients
-- heartbeat this column every ~30 s while the tab is visible; writing
-- is covered by the "users can update their own profile" policy above,
-- reading by the public-read policy.
alter table public.profiles add column if not exists last_seen_at timestamptz not null default now();

-- Editable profile info shown in the chat header and profile viewer.
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists bio text;

drop policy if exists "profiles are publicly readable (public fields only)" on public.profiles;
create policy "profiles are publicly readable (public fields only)"
  on public.profiles for select
  using (true);
  -- Note: everything in this table is either public (username, public_key)
  -- or useless without the passphrase (encrypted_private_key). That's what
  -- makes it safe for any logged-in or anonymous reader to look up a
  -- username and fetch the public key needed to start a chat.

drop policy if exists "users can insert their own profile" on public.profiles;
create policy "users can insert their own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists "users can update their own profile" on public.profiles;
create policy "users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- ---------------------------------------------------------
-- 1b. CHAT PREFERENCES AND SHARED BACKGROUNDS
-- Nicknames are local to one user's view of one conversation.
-- Backgrounds are encrypted with the conversation key and shared
-- by reference, while the file remains in its uploader's folder.
-- ---------------------------------------------------------
create table if not exists public.chat_preferences (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  partner_id uuid not null references public.profiles(id) on delete cascade,
  partner_nickname text,
  auto_delete boolean not null default true,
  primary key (owner_id, partner_id),
  check (owner_id <> partner_id)
);

alter table public.chat_preferences add column if not exists auto_delete boolean not null default true;
-- Per-chat auto-delete duration in minutes (used when auto_delete is on:
-- 10 = ten minutes, 60 = an hour, 1440 = a day).
alter table public.chat_preferences add column if not exists auto_delete_minutes int not null default 10;
alter table public.chat_preferences enable row level security;
drop policy if exists "users manage their own chat preferences" on public.chat_preferences;
create policy "users manage their own chat preferences"
  on public.chat_preferences for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create table if not exists public.chat_backgrounds (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  partner_id uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null unique,
  file_iv text not null,
  created_at timestamptz not null default now(),
  check (owner_id <> partner_id)
);

alter table public.chat_backgrounds enable row level security;
drop policy if exists "chat members can read shared backgrounds" on public.chat_backgrounds;
create policy "chat members can read shared backgrounds"
  on public.chat_backgrounds for select
  using (auth.uid() = owner_id or auth.uid() = partner_id);

drop policy if exists "users can share backgrounds they upload" on public.chat_backgrounds;
create policy "users can share backgrounds they upload"
  on public.chat_backgrounds for insert
  with check (auth.uid() = owner_id);

drop policy if exists "users can delete backgrounds they own" on public.chat_backgrounds;
create policy "users can delete backgrounds they own"
  on public.chat_backgrounds for delete
  using (auth.uid() = owner_id);

-- ---------------------------------------------------------
-- 2. MESSAGES
-- Each message is stored as TWO rows — one "owned" by the
-- sender, one "owned" by the receiver — both holding the
-- same ciphertext (it's decryptable by both sides because
-- ECDH shared secrets are symmetric). Storing two rows lets
-- each side's copy be deleted independently, which is what
-- makes "auto-delete on her side, keep on mine" possible
-- without the server ever seeing plaintext.
-- ---------------------------------------------------------
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null,          -- links the two copies of the same message together
  owner_id uuid not null references public.profiles(id) on delete cascade,   -- whose copy this row is
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null default 'text' check (kind in ('text', 'image', 'video')),
  ciphertext text not null,        -- base64 AES-GCM ciphertext (text) or caption ('' if no caption)
  iv text not null,                -- base64 IV used for the ciphertext/caption above
  storage_path text,               -- set for image/video: path in the encrypted-media bucket
  file_iv text,                    -- base64 IV used to encrypt the media file itself (image/video only)
  created_at timestamptz not null default now(),
  delivered_at timestamptz,        -- when the recipient's app acknowledged this copy
  read_at timestamptz,             -- set when the owner actually opens/reads this copy
  delete_at timestamptz            -- auto-delete deadline; null means this copy is retained
);

alter table public.messages add column if not exists delivered_at timestamptz;
-- Starred messages: per-user flag on the user's own copy.
alter table public.messages add column if not exists starred boolean not null default false;

-- 'audio' = voice notes recorded in the app, encrypted like other media.
-- The CHECK constraint ships with the table (fresh installs) and is
-- swapped here for databases created by earlier versions.
alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind in ('text', 'image', 'video', 'audio'));

alter table public.messages enable row level security;

create index if not exists messages_owner_idx on public.messages (owner_id, created_at desc);
create index if not exists messages_conversation_idx on public.messages (owner_id, sender_id, receiver_id);
create index if not exists messages_delete_at_idx on public.messages (delete_at) where delete_at is not null;

drop policy if exists "users read only their own copy of a message" on public.messages;
create policy "users read only their own copy of a message"
  on public.messages for select
  using (auth.uid() = owner_id);

drop policy if exists "users insert messages where they are sender or receiver" on public.messages;
drop policy if exists "participants can insert message copies" on public.messages;
create policy "participants can insert message copies"
  on public.messages for insert
  with check (
    auth.uid() = sender_id
    and sender_id <> receiver_id
    and owner_id in (sender_id, receiver_id)
  );

drop policy if exists "users update only their own copy (e.g. mark read)" on public.messages;
create policy "users update only their own copy (e.g. mark read)"
  on public.messages for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "users delete only their own copy" on public.messages;
create policy "users delete only their own copy"
  on public.messages for delete
  using (auth.uid() = owner_id);

drop function if exists public.send_chat_message_copies(uuid, uuid, text, text, text, text, text, timestamptz);
create function public.send_chat_message_copies(
  p_group_id uuid,
  p_receiver_id uuid,
  p_kind text,
  p_ciphertext text,
  p_iv text,
  p_storage_path text,
  p_file_iv text,
  p_delete_at timestamptz
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_sender_id uuid := auth.uid();
  v_sent_at timestamptz := now();
  v_receiver_auto_delete boolean;
begin
  if v_sender_id is null then
    raise exception 'Authentication required';
  end if;
  if p_receiver_id is null or p_receiver_id = v_sender_id then
    raise exception 'Invalid message recipient';
  end if;
  if p_kind is null or p_kind not in ('text', 'image', 'video', 'audio') then
    raise exception 'Invalid message kind';
  end if;
  if p_kind = 'text' and (p_storage_path is not null or p_file_iv is not null) then
    raise exception 'Text messages cannot include a media file';
  end if;
  if p_kind in ('image', 'video', 'audio')
    and (p_storage_path is null or p_file_iv is null or split_part(p_storage_path, '/', 1) <> v_sender_id::text) then
    raise exception 'Invalid message media';
  end if;

  -- Respect the RECEIVER's own auto-delete preference for their copy.
  -- Previously the sender's per-chat setting was stamped onto the
  -- receiver's row too, so an unread message could vanish after 10
  -- minutes even when the receiver had auto-delete switched off.
  -- No plaintext is involved here — only a boolean preference.
  select c.auto_delete
    into v_receiver_auto_delete
    from public.chat_preferences c
    where c.owner_id = p_receiver_id
      and c.partner_id = v_sender_id;
  v_receiver_auto_delete := coalesce(v_receiver_auto_delete, true);

  insert into public.messages (
    group_id, owner_id, sender_id, receiver_id, kind,
    ciphertext, iv, storage_path, file_iv, created_at, delete_at
  ) values
    (
      p_group_id, v_sender_id, v_sender_id, p_receiver_id, p_kind,
      p_ciphertext, p_iv, p_storage_path, p_file_iv, v_sent_at, p_delete_at
    ),
    (
      p_group_id, p_receiver_id, v_sender_id, p_receiver_id, p_kind,
      p_ciphertext, p_iv, p_storage_path, p_file_iv, v_sent_at,
      case when v_receiver_auto_delete then p_delete_at else null end
    );
  return v_sent_at;
end;
$function$;

revoke all on function public.send_chat_message_copies(uuid, uuid, text, text, text, text, text, timestamptz) from public, anon;
grant execute on function public.send_chat_message_copies(uuid, uuid, text, text, text, text, text, timestamptz) to authenticated;

create or replace function public.mark_chat_messages_delivered(p_group_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_receiver_id uuid := auth.uid();
begin
  if v_receiver_id is null then
    raise exception 'Authentication required';
  end if;
  if p_group_ids is null or cardinality(p_group_ids) = 0 then
    return;
  end if;

  update public.messages
  set delivered_at = coalesce(delivered_at, clock_timestamp())
  where group_id = any(p_group_ids)
    and receiver_id = v_receiver_id
    and delivered_at is null;
end;
$function$;

create or replace function public.mark_chat_messages_read(p_group_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_receiver_id uuid := auth.uid();
begin
  if v_receiver_id is null then
    raise exception 'Authentication required';
  end if;
  if p_group_ids is null or cardinality(p_group_ids) = 0 then
    return;
  end if;

  update public.messages
  set delivered_at = coalesce(delivered_at, clock_timestamp()),
      read_at = coalesce(read_at, clock_timestamp())
  where group_id = any(p_group_ids)
    and receiver_id = v_receiver_id
    and (delivered_at is null or read_at is null);
end;
$function$;

revoke all on function public.mark_chat_messages_delivered(uuid[]) from public, anon;
grant execute on function public.mark_chat_messages_delivered(uuid[]) to authenticated;
revoke all on function public.mark_chat_messages_read(uuid[]) from public, anon;
grant execute on function public.mark_chat_messages_read(uuid[]) to authenticated;

-- ---------------------------------------------------------
-- 2b. MESSAGE REACTIONS
-- One row per (message, reactor). group_id is the shared id of
-- both copies of a message; visibility is derived from the
-- reader's own copy, so the server never needs plaintext.
-- ---------------------------------------------------------
create table if not exists public.message_reactions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null,
  reactor_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  unique (group_id, reactor_id)
);

create index if not exists message_reactions_group_idx on public.message_reactions (group_id);
alter table public.message_reactions enable row level security;

drop policy if exists "chat members can read reactions" on public.message_reactions;
create policy "chat members can read reactions"
  on public.message_reactions for select
  using (
    auth.uid() = reactor_id
    or exists (
      select 1 from public.messages m
      where m.group_id = message_reactions.group_id and m.owner_id = auth.uid()
    )
  );

drop policy if exists "users react with their own account" on public.message_reactions;
create policy "users react with their own account"
  on public.message_reactions for insert
  with check (
    auth.uid() = reactor_id
    and exists (
      select 1 from public.messages m
      where m.group_id = message_reactions.group_id and m.owner_id = auth.uid()
    )
  );

drop policy if exists "users remove their own reactions" on public.message_reactions;
create policy "users remove their own reactions"
  on public.message_reactions for delete
  using (auth.uid() = reactor_id);

-- ---------------------------------------------------------
-- 3. STATUSES (stories)
-- Visible to one other person for 24 hours, same two-row
-- pattern isn't needed here since status is view-then-gone
-- by nature; a single row per status with an expiry works.
-- ---------------------------------------------------------
create table if not exists public.statuses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  viewer_id uuid not null references public.profiles(id) on delete cascade, -- the one person it's shared with
  kind text not null default 'text' check (kind in ('text', 'image', 'video')),
  ciphertext text not null,
  iv text not null,
  storage_path text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  viewed_at timestamptz
);

alter table public.statuses enable row level security;

-- Background preset name for text statuses ('grape', 'teal', ...).
-- It is only a UI color, not sensitive, so it is stored unencrypted.
alter table public.statuses add column if not exists bg text;

create index if not exists statuses_viewer_idx on public.statuses (viewer_id, expires_at);
create index if not exists statuses_owner_idx on public.statuses (owner_id, expires_at);

drop policy if exists "owner or viewer can read a status" on public.statuses;
create policy "owner or viewer can read a status"
  on public.statuses for select
  using (auth.uid() = owner_id or auth.uid() = viewer_id);

drop policy if exists "owner can post a status" on public.statuses;
create policy "owner can post a status"
  on public.statuses for insert
  with check (auth.uid() = owner_id and viewer_id <> auth.uid());

drop policy if exists "viewer can mark a status viewed" on public.statuses;
create policy "viewer can mark a status viewed"
  on public.statuses for update
  using (auth.uid() = viewer_id)
  with check (auth.uid() = viewer_id);

drop policy if exists "owner can delete their own status" on public.statuses;
create policy "owner can delete their own status"
  on public.statuses for delete
  using (auth.uid() = owner_id);

-- ---------------------------------------------------------
-- 4. STORAGE — encrypted media bucket
-- Files are encrypted client-side BEFORE upload, so the
-- bucket holding them can be private; even Supabase staff
-- looking at the raw bytes only see ciphertext.
-- ---------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('encrypted-media', 'encrypted-media', false)
on conflict (id) do nothing;

drop policy if exists "users upload to their own folder" on storage.objects;
create policy "users upload to their own folder"
  on storage.objects for insert
  with check (
    bucket_id = 'encrypted-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users read files in their own folder" on storage.objects;
create policy "users read files in their own folder"
  on storage.objects for select
  using (
    bucket_id = 'encrypted-media'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1 from public.messages m
        where m.owner_id = auth.uid() and m.storage_path = name
      )
      or exists (
        select 1 from public.profiles p
        where auth.uid() is not null and p.avatar_url = name
      )
      or exists (
        select 1 from public.chat_backgrounds b
        where b.storage_path = name
          and (b.owner_id = auth.uid() or b.partner_id = auth.uid())
      )
      or exists (
        select 1 from public.statuses s
        where s.storage_path = name
          and (s.owner_id = auth.uid() or s.viewer_id = auth.uid())
      )
    )
  );

drop policy if exists "users update files in their own folder" on storage.objects;
create policy "users update files in their own folder"
  on storage.objects for update
  using (
    bucket_id = 'encrypted-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'encrypted-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users delete files in their own folder" on storage.objects;
create policy "users delete files in their own folder"
  on storage.objects for delete
  using (
    bucket_id = 'encrypted-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Message media starts in the sender's folder. The recipient copies it
-- into their own folder before reading so the two copies expire independently.

-- ---------------------------------------------------------
-- 5. REALTIME
-- Turn on realtime so new messages/statuses push instantly.
-- ---------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'statuses'
  ) then
    alter publication supabase_realtime add table public.statuses;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_backgrounds'
  ) then
    alter publication supabase_realtime add table public.chat_backgrounds;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_reactions'
  ) then
    alter publication supabase_realtime add table public.message_reactions;
  end if;
end
$$;

-- =========================================================
-- Done. There is no scheduled server-side deletion job here
-- on purpose (pg_cron isn't guaranteed on the free tier).
-- Instead, the app deletes expired rows itself, lazily,
-- every time a user opens the chat or status screen. See
-- the cleanupExpired() functions in the app's JS files.
-- =========================================================
