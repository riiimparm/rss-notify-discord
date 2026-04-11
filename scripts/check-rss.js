import { XMLParser } from 'fast-xml-parser';
import fetch from 'node-fetch';
import fs from 'fs';

const feedsFile = process.env.FEEDS_FILE ?? './feeds-daily.js';
const { FEEDS } = await import(feedsFile);

const STATE_FILE = 'rss-state.json';
const parser = new XMLParser({ ignoreAttributes: false });

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Discord Embed形式でまとめて送信（1フィードにつき1リクエスト）
async function notify(feed, items) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

  const embeds = items.map(item => ({
    title: item.title,
    url: item.link,
    color: 0x5865f2,  // Discord Blurple
    footer: { text: feed.name },
    timestamp: new Date().toISOString(),
  }));

  // Discordは1リクエストあたりembed最大10件
  for (let i = 0; i < embeds.length; i += 10) {
    const chunk = embeds.slice(i, i + 10);
    const payload = {
      embeds: chunk,
    };

    console.log(`NEW [${feed.name}]:`, chunk.map(e => e.title));

    if (webhookUrl) {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      // Discordのレート制限対策
      if (res.status === 429) {
        const retry = (await res.json()).retry_after ?? 1;
        console.warn(`Rate limited. Waiting ${retry}s...`);
        await new Promise(r => setTimeout(r, retry * 1000));
        i -= 10; // 同チャンクを再送
      }
    }
  }
}

function getItemDate(item) {
  const raw =
    item.pubDate ??       // RSS 2.0
    item.published ??     // Atom
    item.updated ??       // Atom
    item['dc:date'];      // RSS 1.0 / Dublin Core
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

async function checkFeed(feed, state) {
  const res = await fetch(feed.url, { timeout: 10000 });
  const xml = await res.text();
  const data = parser.parse(xml);

  const channel = data.rss?.channel ?? data.feed;
  const rawItems = channel.item ?? channel.entry ?? [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  const dated = items
    .map(item => ({ item, date: getItemDate(item) }))
    .filter(x => x.date !== null);

  if (dated.length === 0) {
    console.warn(`[${feed.name}] No dated items found; skipping.`);
    return { newItems: [], silentInit: false };
  }

  const newestDate = dated.reduce(
    (max, x) => (x.date > max ? x.date : max),
    new Date(0),
  );

  // B-3: Silent init — 前回state無し(初回 or キャッシュ消失 or 旧フォーマット)は
  // 通知せず現時点の最新日時だけ記録し、次回以降の差分通知に備える。
  const prevRaw = state[feed.url];
  const prevDate = typeof prevRaw === 'string' ? new Date(prevRaw) : null;
  if (prevDate === null || isNaN(prevDate.getTime())) {
    state[feed.url] = newestDate.toISOString();
    return { newItems: [], silentInit: true };
  }

  // B-2: lastSeenAt より新しいアイテムのみを新着として通知。
  const newItems = dated
    .filter(x => x.date > prevDate)
    .sort((a, b) => a.date - b.date) // 古い順に通知
    .map(({ item }) => ({
      title: item.title,
      link: item.link ?? item.id,
    }));

  state[feed.url] = newestDate.toISOString();
  return { newItems, silentInit: false };
}

async function main() {
  const state = loadState();

  for (const feed of FEEDS) {
    try {
      const { newItems, silentInit } = await checkFeed(feed, state);
      if (silentInit) {
        console.log(`[${feed.name}] Silent init: recorded current state without notifying.`);
      } else if (newItems.length > 0) {
        await notify(feed, newItems);
      } else {
        console.log(`[${feed.name}] No new items.`);
      }
    } catch (err) {
      console.error(`[${feed.name}] Error:`, err.message);
    }
  }

  saveState(state);
}

main();
