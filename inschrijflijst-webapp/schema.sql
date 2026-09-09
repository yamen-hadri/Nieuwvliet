-- ============================================================
-- Inschrijflijst Nieuwvliet — Supabase schema
-- شغّل هالملف كامل مرة وحدة من Supabase Dashboard > SQL Editor > New query
-- ============================================================

create extension if not exists pgcrypto;

-- بنك بيانات العمّال (بديل ملف الإكسل القديم)
create table if not exists workers (
  id uuid primary key default gen_random_uuid(),
  voornaam text not null,
  achternaam text not null default '',
  nationaliteit text not null default '',
  type_legitimatie text not null default '',
  documentnummer text not null default '',
  bsn text not null default '',
  geldig_van date,
  geldig_tot date,
  kopie_id text not null default 'ja',
  twv_kopie text not null default 'ja',
  created_at timestamptz not null default now()
);

create index if not exists workers_achternaam_idx on workers (achternaam);

-- إذا كنت شغّلت هالملف قبل ما تصير الكنية اختيارية، هالسطر بيسمحلها تكون فاضية
-- (آمن تشغّله أكتر من مرة، ما بيأثر عالبيانات الموجودة):
alter table workers alter column achternaam drop not null;
alter table workers alter column achternaam set default '';

-- ============================================================
-- الأمان: بس المستخدمين المسجلين (اللي عملتلهم حساب إنت) يقدروا
-- يشوفوا أو يعدلوا الداتا. ما في تسجيل عام مفتوح لأي حد.
-- ============================================================
alter table workers enable row level security;

create policy "authenticated full access" on workers
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ============================================================
-- تفعيل التحديث اللحظي (Realtime) — أي إضافة/تعديل/حذف من جهاز
-- بيوصل فوراً للجهاز التاني
-- ============================================================
alter publication supabase_realtime add table workers;
