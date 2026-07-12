-- WhatsApp Business AI Agent — Supabase (PostgreSQL) schema
-- ---------------------------------------------------------------------------
-- Postgres-native translation of backend/prisma/schema.prisma.
-- Unlike the SQLite build, JSON columns use jsonb and timestamps use timestamptz.
--
-- Run this in the Supabase SQL editor (Database → SQL Editor → New query → Run),
-- or: psql "<your-supabase-connection-string>" -f backend/supabase/schema.sql
--
-- Safe to re-run: every object uses IF NOT EXISTS / CREATE OR REPLACE.
-- IDs default to a cuid-like value so manual inserts work; the Prisma client
-- still supplies its own cuid() on insert, which takes precedence.
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto; -- gen_random_uuid()

-- Fallback id generator for rows inserted outside Prisma (e.g. Supabase UI).
create or replace function gen_id() returns text
  language sql volatile as $$ select replace(gen_random_uuid()::text, '-', '') $$;

-- Keep updatedAt fresh on UPDATE (Prisma sets it from the app; this covers
-- direct SQL edits in the Supabase dashboard).
create or replace function set_updated_at() returns trigger
  language plpgsql as $$
begin
  new."updatedAt" := now();
  return new;
end $$;

-- ─────────────────────────────────────────────────────────────
-- Auth
-- ─────────────────────────────────────────────────────────────
create table if not exists "AdminUser" (
  "id"           text primary key default gen_id(),
  "email"        text not null unique,
  "name"         text not null,
  "passwordHash" text not null,
  "role"         text not null default 'admin',
  "createdAt"    timestamptz not null default now(),
  "updatedAt"    timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Core domain
-- ─────────────────────────────────────────────────────────────
create table if not exists "Customer" (
  "id"        text primary key default gen_id(),
  "name"      text,
  "phone"     text not null unique,
  "email"     text,
  "tags"      jsonb not null default '[]'::jsonb,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists "Link" (
  "id"            text primary key default gen_id(),
  "name"          text not null,
  "url"           text not null,
  "description"   text,
  "relatedFlowId" text,
  "isActive"      boolean not null default true,
  "trackClicks"   boolean not null default true,
  "showOnBio"     boolean not null default false, -- show on the public /l link page
  "clicksCount"   integer not null default 0,
  "createdAt"     timestamptz not null default now(),
  "updatedAt"     timestamptz not null default now()
);
-- Patch pre-existing Link tables created before showOnBio existed.
alter table "Link" add column if not exists "showOnBio" boolean not null default false;

create table if not exists "Flow" (
  "id"           text primary key default gen_id(),
  "name"         text not null,
  "description"  text,
  "triggerWords" jsonb not null default '[]'::jsonb,
  "finalMessage" text,
  "sendFinalMessage" boolean not null default true, -- when false, no closing message at flow end
  "linkId"       text references "Link"("id") on delete set null,
  "isActive"     boolean not null default true,
  "isDefault"    boolean not null default false,
  "createdAt"    timestamptz not null default now(),
  "updatedAt"    timestamptz not null default now()
);
-- Patch pre-existing Flow tables created before sendFinalMessage existed.
alter table "Flow" add column if not exists "sendFinalMessage" boolean not null default true;

-- Link.relatedFlowId references Flow; added after Flow exists to break the cycle.
alter table "Link"
  drop constraint if exists "Link_relatedFlowId_fkey",
  add constraint "Link_relatedFlowId_fkey"
    foreign key ("relatedFlowId") references "Flow"("id") on delete set null;

create table if not exists "Conversation" (
  "id"                text primary key default gen_id(),
  "customerId"        text not null references "Customer"("id") on delete cascade,
  "whatsappPhone"     text not null,
  "status"            text not null default 'active', -- active | completed | abandoned | needs_human
  "intent"            text,
  "currentFlowId"     text references "Flow"("id") on delete set null,
  "currentQuestionId" text,
  "needsHuman"        boolean not null default false,
  "lastMessage"       text,
  "leadScore"         integer not null default 0,
  "linkSent"          boolean not null default false,
  "assignedTo"        text,
  "tags"              jsonb not null default '[]'::jsonb,
  "notes"             text,
  "createdAt"         timestamptz not null default now(),
  "updatedAt"         timestamptz not null default now(),
  "lastActivityAt"    timestamptz not null default now()
);
create index if not exists "Conversation_status_idx"     on "Conversation"("status");
create index if not exists "Conversation_customerId_idx" on "Conversation"("customerId");

create table if not exists "Message" (
  "id"             text primary key default gen_id(),
  "conversationId" text not null references "Conversation"("id") on delete cascade,
  "senderType"     text not null, -- customer | agent | human
  "messageText"    text not null,
  "intent"         text,
  "rawPayload"     jsonb,
  "createdAt"      timestamptz not null default now()
);
create index if not exists "Message_conversationId_idx" on "Message"("conversationId");

create table if not exists "FlowQuestion" (
  "id"           text primary key default gen_id(),
  "flowId"       text not null references "Flow"("id") on delete cascade,
  "questionText" text not null,
  "questionType" text not null default 'text', -- text|phone|email|number|single_choice|multiple_choice|yes_no|date|custom
  "options"      jsonb not null default '[]'::jsonb,
  "voiceUrl"     text, -- optional pre-recorded voice note sent when this question is asked
  "imageUrl"     text, -- optional image sent when this question is asked
  "isRequired"   boolean not null default true,
  "orderIndex"   integer not null default 0,
  "createdAt"    timestamptz not null default now(),
  "updatedAt"    timestamptz not null default now()
);
-- Patch pre-existing FlowQuestion tables that were created before these existed.
alter table "FlowQuestion" add column if not exists "voiceUrl" text;
alter table "FlowQuestion" add column if not exists "imageUrl" text;
create index if not exists "FlowQuestion_flowId_idx" on "FlowQuestion"("flowId");

create table if not exists "CustomerAnswer" (
  "id"             text primary key default gen_id(),
  "conversationId" text not null references "Conversation"("id") on delete cascade,
  "customerId"     text not null references "Customer"("id") on delete cascade,
  "flowId"         text references "Flow"("id") on delete set null,
  "questionId"     text references "FlowQuestion"("id") on delete set null,
  "questionText"   text,
  "answer"         text not null,
  "createdAt"      timestamptz not null default now()
);
create index if not exists "CustomerAnswer_conversationId_idx" on "CustomerAnswer"("conversationId");

create table if not exists "AnalyticsEvent" (
  "id"             text primary key default gen_id(),
  "eventName"      text not null,
  "conversationId" text references "Conversation"("id") on delete set null,
  "customerId"     text references "Customer"("id") on delete set null,
  "customerPhone"  text,
  "flowId"         text references "Flow"("id") on delete set null,
  "questionId"     text,
  "metadata"       jsonb,
  "createdAt"      timestamptz not null default now()
);
create index if not exists "AnalyticsEvent_eventName_idx" on "AnalyticsEvent"("eventName");
create index if not exists "AnalyticsEvent_createdAt_idx" on "AnalyticsEvent"("createdAt");

-- ─────────────────────────────────────────────────────────────
-- Broadcast guardrails
-- ─────────────────────────────────────────────────────────────

-- Numbers that must never receive broadcasts (opt-out keyword or manual).
create table if not exists "SuppressedNumber" (
  "id"        text primary key default gen_id(),
  "phone"     text not null unique,
  "reason"    text not null default 'opt_out',
  "createdAt" timestamptz not null default now()
);

-- A broadcast campaign processed in the background; cursor enables resume.
create table if not exists "BroadcastJob" (
  "id"                 text primary key default gen_id(),
  "status"             text not null default 'running',
  "abortReason"        text,
  "mode"               text not null default 'template',
  "templateName"       text,
  "languageCode"       text,
  "message"            text,
  "headerImageLink"    text,
  "headerImageId"      text,
  "requireHeaderImage" boolean not null default false,
  "throttleMs"         integer not null default 300,
  "contacts"           jsonb not null,
  "cursor"             integer not null default 0,
  "total"              integer not null,
  "sent"               integer not null default 0,
  "failedCount"        integer not null default 0,
  "invalidCount"       integer not null default 0,
  "suppressedCount"    integer not null default 0,
  "duplicatesRemoved"  integer not null default 0,
  "failures"           jsonb not null default '[]'::jsonb,
  "invalid"            jsonb not null default '[]'::jsonb,
  "createdAt"          timestamptz not null default now(),
  "updatedAt"          timestamptz not null default now()
);
create index if not exists "BroadcastJob_status_idx" on "BroadcastJob"("status");

-- Ledger of business-initiated sends — powers the rolling-24h messaging cap.
create table if not exists "OutboundSend" (
  "id"        text primary key default gen_id(),
  "phone"     text not null,
  "jobId"     text,
  "createdAt" timestamptz not null default now()
);
create index if not exists "OutboundSend_createdAt_idx" on "OutboundSend"("createdAt");

-- Knowledge base is a singleton record the agent answers from.
create table if not exists "KnowledgeBase" (
  "id"                  text primary key default gen_id(),
  "businessDescription" text,
  "productInfo"         text,
  "serviceInfo"         text,
  "prices"              text,
  "shippingInfo"        text,
  "returnPolicy"        text,
  "faq"                 text,
  "openingHours"        text,
  "contactDetails"      text,
  "limitations"         text,
  "customInstructions"  text,
  "createdAt"           timestamptz not null default now(),
  "updatedAt"           timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────
-- Storage: public bucket for question voice notes
-- (public read so WhatsApp can fetch the audio by URL; server uploads use the
-- service-role key, which bypasses RLS).
-- ─────────────────────────────────────────────────────────────
insert into storage.buckets ("id", "name", "public")
values ('voice-notes', 'voice-notes', true)
on conflict ("id") do update set "public" = excluded."public";

-- ─────────────────────────────────────────────────────────────
-- updatedAt triggers (tables that have an updatedAt column)
-- ─────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'AdminUser','Customer','Link','Flow','Conversation',
    'FlowQuestion','KnowledgeBase','BroadcastJob'
  ] loop
    execute format('drop trigger if exists set_updated_at on %I', t);
    execute format(
      'create trigger set_updated_at before update on %I
         for each row execute function set_updated_at()', t);
  end loop;
end $$;
