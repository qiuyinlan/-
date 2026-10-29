-- ====================================================================
-- 回忆 · 云端同步：表结构 + 访问规则
--
-- 怎么用：Supabase 控制台 → 左侧 SQL Editor → New query → 整段粘进来 → Run。
-- 跑一次就够。整份脚本是**可重复执行**的（都带 if not exists / drop policy if exists），
-- 以后改结构再跑一遍也不会报错。
--
-- ── 为什么只有一张表 ────────────────────────────────────────────────
-- 回忆的整个数据本来就是 Deck[]（卡组 + 卡片 + 复习进度），
-- 一个账号一行，doc 里装整份**信封**：
--   { v, schemaVersion, decks, deleted, deviceId, savedAt }
-- （格式见 src/lib/cloudMerge.ts）。
-- 一个账号一行的好处：导出 = 序列化、快照 = 存副本这些操作全都零成本，
-- 数据出事故的概率也低。拆成 decks / cards 多张表当然也能做，但「合并
-- 只在两份数据之间做」这件事反而更麻烦。
-- ====================================================================

create table if not exists public.app_data (
  -- 一个账号一行：user_id 既是主键也是外键，账号被删时数据跟着删
  user_id    uuid primary key references auth.users (id) on delete cascade,
  -- 整份信封：{ v, schemaVersion, decks, deleted, deviceId, savedAt }
  doc        jsonb not null,
  -- 乐观并发版本号。每次成功写入 +1；客户端写入时带上它读到的那个值，
  -- 对不上就说明**期间别的设备写过** → 不许覆盖，先合并再重试。
  -- 这是「手机上的改动被电脑整份覆盖掉」唯一的防线，别去掉。
  rev        bigint not null default 1,
  -- 最后写入的设备。用来判断「这次拿到的远端数据是不是我自己刚推的」，
  -- 免得同一份东西来回推、来回合并。
  device_id  text,
  updated_at timestamptz not null default now()
);

comment on table  public.app_data is '回忆：一个账号一行，doc 是整份数据信封（卡组 + 删除墓碑）';
comment on column public.app_data.rev is '乐观并发：客户端带旧 rev 写入时匹配不到行，据此判定冲突 → 先合并再重试';
comment on column public.app_data.doc is '信封格式见 src/lib/cloudMerge.ts；schemaVersion 高于客户端时客户端会拒绝写入';

-- --------------------------------------------------------------------
-- 行级安全（RLS）—— 这是安全底线，不是可选项
--
-- 前端用的 anon key 是**公开**的（打进 JS，谁都能看到）。
-- 没有 RLS 的话，任何人拿到这个 key 就能 select 出所有人的数据。
-- 打开 RLS 之后，下面的策略把每一行锁死在 auth.uid() = user_id 上：
-- 每个账号只能看见、只能改自己那一行，别人写的行连「看见」都做不到。
-- --------------------------------------------------------------------
alter table public.app_data enable row level security;

drop policy if exists "自己的数据 · 读" on public.app_data;
create policy "自己的数据 · 读" on public.app_data
  for select
  using (auth.uid() = user_id);

-- with check 和 using 都要写：
--   using     管「这一行你碰得到吗」（读 / 改 / 删时筛已有行）
--   with check 管「你写进去的这行合规吗」（插入 / 改完之后的新行）
-- 少了 with check，插入时就能伪造 user_id 把数据写到别人那一行上。
drop policy if exists "自己的数据 · 插入" on public.app_data;
create policy "自己的数据 · 插入" on public.app_data
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "自己的数据 · 更新" on public.app_data;
create policy "自己的数据 · 更新" on public.app_data
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "自己的数据 · 删除" on public.app_data;
create policy "自己的数据 · 删除" on public.app_data
  for delete
  using (auth.uid() = user_id);

-- --------------------------------------------------------------------
-- 权限：只给「已登录」的角色，anon（未登录）一个权限都不给。
--
-- 未登录的人连表都读不到，这才是我们想要的状态 ——
-- 同步功能的前提就是先登录。
-- --------------------------------------------------------------------
revoke all on public.app_data from anon;
grant select, insert, update, delete on public.app_data to authenticated;

-- --------------------------------------------------------------------
-- 自检：跑完之后应该看到一行，rowsecurity = true
-- --------------------------------------------------------------------
-- select relname, relrowsecurity from pg_class where relname = 'app_data';
