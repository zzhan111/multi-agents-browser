// Transform adapter files: inject @disclaimer header + extend @meta with
// title/category/risk/prerequisites. readOnly is preserved from existing @meta.
//
// Run: node transform-adapters.mjs
// Operates on C:\Users\zhang\.bb-browser\sites\ (in place).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SITES_DIR = join(homedir(), '.bb-browser', 'sites');

// Per-adapter metadata. Keyed by adapter `name` (platform/command).
// title = human-readable; category/risk/prerequisites per legal classification.
const META = {
  // ── xiaohongshu (社交, high) ──
  'xiaohongshu/follow':              { title: '关注/取消关注小红书用户', category: '社交', risk: 'high', prerequisites: '需先登录 xiaohongshu.com' },
  'xiaohongshu/like':                { title: '点赞/取消点赞小红书笔记', category: '社交', risk: 'high', prerequisites: '需先登录 xiaohongshu.com' },
  'xiaohongshu/favorite':            { title: '收藏/取消收藏小红书笔记', category: '社交', risk: 'high', prerequisites: '需先登录 xiaohongshu.com' },
  'xiaohongshu/comment-post':        { title: '在小红书笔记下发表评论', category: '社交', risk: 'high', prerequisites: '需先登录 xiaohongshu.com' },
  'xiaohongshu/comment-delete':      { title: '删除自己在小红书的评论', category: '社交', risk: 'high', prerequisites: '需先登录 xiaohongshu.com' },
  'xiaohongshu/post-create':         { title: '发布小红书图文笔记', category: '社交', risk: 'high', prerequisites: '需先登录 xiaohongshu.com' },
  'xiaohongshu/post-delete':         { title: '删除自己发布的小红书笔记', category: '社交', risk: 'high', prerequisites: '需先登录 xiaohongshu.com' },
  'xiaohongshu/search':              { title: '搜索小红书笔记', category: '社交', risk: 'high', prerequisites: '需先登录 xiaohongshu.com' },
  'xiaohongshu/feed':                { title: '读取小红书首页推荐流', category: '社交', risk: 'high', prerequisites: '需先登录 xiaohongshu.com' },
  'xiaohongshu/post-detail':         { title: '获取小红书笔记详情', category: '社交', risk: 'high', prerequisites: '需先登录 xiaohongshu.com,需笔记 xsecToken' },
  'xiaohongshu/comments':            { title: '读取小红书笔记评论', category: '社交', risk: 'high', prerequisites: '需先登录 xiaohongshu.com,需笔记 xsecToken' },
  'xiaohongshu/user':                { title: '查看小红书用户资料', category: '社交', risk: 'high', prerequisites: '需先登录 xiaohongshu.com' },
  'xiaohongshu/user-notes':          { title: '查看小红书用户笔记列表', category: '社交', risk: 'high', prerequisites: '需先登录 xiaohongshu.com' },
  'xiaohongshu/notifications':       { title: '读取小红书通知消息', category: '社交', risk: 'high', prerequisites: '需先登录 xiaohongshu.com' },
  'xiaohongshu/unread':              { title: '查询小红书未读消息数', category: '社交', risk: 'high', prerequisites: '需先登录 xiaohongshu.com' },
  'xiaohongshu/auth':                { title: '检查小红书登录状态', category: '社交', risk: 'high', prerequisites: '无' },
  'xiaohongshu/get-trending-content':{ title: '获取小红书热门短视频', category: '社交', risk: 'high', prerequisites: '无' },

  // ── twitter (社交, high) ──
  'twitter/tweets':                  { title: '查看用户推文动态', category: '社交', risk: 'high', prerequisites: '需先登录 x.com' },

  // ── jike (社交, high) ──
  'jike/following':                  { title: '读取即刻关注流', category: '社交', risk: 'high', prerequisites: '需先登录 web.okjike.com' },

  // ── 1688 (电商, medium) ──
  '1688/auth':                       { title: '检查 1688 登录状态', category: '电商', risk: 'medium', prerequisites: '需先登录 1688.com' },
  '1688/search':                     { title: '搜索 1688 商品', category: '电商', risk: 'medium', prerequisites: '无' },
  '1688/product':                    { title: '查看 1688 商品详情', category: '电商', risk: 'medium', prerequisites: '需商品 offer ID' },
  '1688/store-search':               { title: '在 1688 店铺内搜索商品', category: '电商', risk: 'medium', prerequisites: '需店铺 ID' },
  '1688/store-freight':              { title: '查看 1688 店铺运费/包邮门槛', category: '电商', risk: 'medium', prerequisites: '需先登录 1688.com' },
  '1688/order-list':                 { title: '查询 1688 订单列表', category: '电商', risk: 'medium', prerequisites: '需先登录 1688.com' },
  '1688/order-detail':               { title: '查看 1688 订单详情', category: '电商', risk: 'medium', prerequisites: '需先登录 1688.com,需订单号' },
  '1688/cart-list':                  { title: '查看 1688 购物车', category: '电商', risk: 'medium', prerequisites: '需先登录 1688.com' },
  '1688/cart-add':                   { title: '加入 1688 购物车', category: '电商', risk: 'medium', prerequisites: '需先登录 1688.com' },
  '1688/cart-remove':                { title: '从 1688 购物车移除商品', category: '电商', risk: 'medium', prerequisites: '需先登录 1688.com' },
  '1688/checkout-preview':           { title: '预览 1688 结算订单(不下单)', category: '电商', risk: 'medium', prerequisites: '需先登录 1688.com' },

  // ── ybm (电商, medium) ──
  'ybm/auth':                        { title: '检查药帮忙登录状态', category: '电商', risk: 'medium', prerequisites: '需先登录 ybm100.com' },
  'ybm/search':                      { title: '搜索药帮忙商品', category: '电商', risk: 'medium', prerequisites: '需先登录 ybm100.com' },
  'ybm/product':                     { title: '查看药帮忙商品详情', category: '电商', risk: 'medium', prerequisites: '需先登录 ybm100.com,需商品条码/ID' },
  'ybm/order-list':                  { title: '查询药帮忙订单列表', category: '电商', risk: 'medium', prerequisites: '需先登录 ybm100.com' },
  'ybm/order-detail':                { title: '查看药帮忙订单详情', category: '电商', risk: 'medium', prerequisites: '需先登录 ybm100.com,需订单号' },
  'ybm/cart-list':                   { title: '查看药帮忙购物车', category: '电商', risk: 'medium', prerequisites: '需先登录 ybm100.com' },
  'ybm/cart-add':                    { title: '加入药帮忙购物车', category: '电商', risk: 'medium', prerequisites: '需先登录 ybm100.com' },
  'ybm/cart-remove':                 { title: '从药帮忙购物车移除商品', category: '电商', risk: 'medium', prerequisites: '需先登录 ybm100.com' },
  'ybm/checkout-preview':            { title: '预览药帮忙结算订单(不下单)', category: '电商', risk: 'medium', prerequisites: '需先登录 ybm100.com' },

  // ── low-risk 电商 ──
  'amazon/search-products':          { title: '搜索 Amazon 商品', category: '电商', risk: 'low', prerequisites: '无' },
  'ebay/find-a-product':             { title: '搜索 eBay 商品', category: '电商', risk: 'low', prerequisites: '无' },
  'aliexpress/search-product':       { title: '搜索速卖通商品', category: '电商', risk: 'low', prerequisites: '无' },
  'taobao/search-products':          { title: '搜索淘宝商品', category: '电商', risk: 'low', prerequisites: '无' },
  'jd/search-products':              { title: '搜索京东商品', category: '电商', risk: 'low', prerequisites: '无' },

  // ── 影视 ──
  'imdb/get-rating':                 { title: '查询 IMDb 影视评分', category: '影视', risk: 'low', prerequisites: '无' },

  // ── 出行 ──
  'airbnb/search-listings':          { title: '搜索 Airbnb 民宿房源', category: '出行', risk: 'low', prerequisites: '无' },
  'google/search-flights':           { title: '搜索 Google 航班', category: '出行', risk: 'low', prerequisites: '无' },
  '12306/find-trains':               { title: '查询 12306 列车时刻与余票', category: '出行', risk: 'low', prerequisites: '无' },
};

// Domain → human label for disclaimer text.
const DOMAIN_LABEL = {
  'social-media': '小红书', 'www.xiaohongshu.com': '小红书',
  'x.com': 'X(Twitter)', 'web.okjike.com': '即刻',
  'www.1688.com': '1688', 's.1688.com': '1688', 'detail.1688.com': '1688',
  'shop.1688.com': '1688', 'cart.1688.com': '1688', 'air.1688.com': '1688', 'buy.1688.com': '1688',
  'www.ybm100.com': '药帮忙',
  'amazon.com': 'Amazon', 'www.ebay.com': 'eBay', 'aliexpress.com': '速卖通',
  'taobao.com': '淘宝', 'search.jd.com': '京东',
  'www.imdb.com': 'IMDb', 'airbnb.com': 'Airbnb', 'google.com': 'Google', 'kyfw.12306.cn': '12306',
};

function disclaimerFor(domain) {
  const label = DOMAIN_LABEL[domain] ?? domain;
  return `/**\n * @disclaimer 本适配器由作者独立维护,ma-browser 不为适配器行为背书。\n *             使用者需遵守 ${label} 服务条款,不得用于反爬/转售/商业化替代。\n *             作者已阅读目标站点 ToS 并认为本适配器合规。\n */\n`;
}

function transformFile(filePath) {
  let src = readFileSync(filePath, 'utf8');
  // Extract @meta to find name + domain.
  const m = /\/\*\s*@meta\s*([\s\S]*?)\*\//.exec(src);
  if (!m) { console.warn(`  SKIP (no @meta): ${filePath}`); return false; }
  let inner = m[1].trim();
  let json;
  try { json = JSON.parse(inner); } catch { console.warn(`  SKIP (bad @meta JSON): ${filePath}`); return false; }
  const name = json.name;
  const domain = json.domain;
  const extra = META[name];
  if (!extra) { console.warn(`  SKIP (not in META table): ${name} ${filePath}`); return false; }

  // Inject the 4 new fields into the JSON object (idempotent: overwrite if present).
  json.title = extra.title;
  json.category = extra.category;
  json.risk = extra.risk;
  json.prerequisites = extra.prerequisites;

  // Rebuild the @meta block with 2-space indented JSON, preserving key order:
  // name, title, description, domain, category, risk, readOnly, prerequisites, args, example, capabilities.
  const ordered = {};
  for (const k of ['name','title','description','domain','category','risk','readOnly','prerequisites','args','example','capabilities']) {
    if (k in json) ordered[k] = json[k];
  }
  // Append any remaining keys not in the order list.
  for (const k of Object.keys(json)) if (!(k in ordered)) ordered[k] = json[k];
  const newMeta = `/* @meta\n${JSON.stringify(ordered, null, 2)}\n*/`;

  // Replace the old @meta block with the new one.
  let out = src.replace(/\/\*\s*@meta\s*[\s\S]*?\*\//, newMeta);

  // Prepend @disclaimer if absent (idempotent).
  if (!/@disclaimer/.test(out)) {
    out = disclaimerFor(domain) + out;
  }
  writeFileSync(filePath, out, 'utf8');
  console.log(`  OK  ${name}  → ${extra.title}`);
  return true;
}

// Walk all .js files under SITES_DIR.
import { readdirSync, statSync } from 'node:fs';
function walk(dir, acc) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const files = walk(SITES_DIR, []);
console.log(`Found ${files.length} adapter files. Transforming...`);
let ok = 0, skip = 0;
for (const f of files) {
  if (transformFile(f)) ok++; else skip++;
}
console.log(`\nDone: ${ok} transformed, ${skip} skipped.`);
