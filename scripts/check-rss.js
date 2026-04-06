import { XMLParser } from 'fast-xml-parser';
import fetch from 'node-fetch';
import fs from 'fs';

const FEEDS = [
  { name: 'keitah', url: 'https://qiita.com/keitah/feed' },
  { name: 'UrayahaDays',   url: 'https://zenn.dev/tenormusica/feed' },
  { name: 'StepSecurity',   url: 'https://www.stepsecurity.io/blog/rss.xml' },
];

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

async function checkFeed(feed, state) {
  const res = await fetch(feed.url, { timeout: 10000 });
  const xml = await res.text();
  const data = parser.parse(xml);

  const channel = data.rss?.channel ?? data.feed;
  const rawItems = channel.item ?? channel.entry ?? [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  const seen = new Set(state[feed.url] ?? []);
  const newItems = [];

  for (const item of items) {
    const guid = item.guid?.['#text'] ?? item.guid ?? item.id ?? item.link;
    const link =
      typeof item.link === 'object'
        ? item.link['@_href']           // Atom
        : item.link ?? item.id;         // RSS
    if (!seen.has(guid)) {
      newItems.push({ guid, title: item.title, link: item.link ?? item.id });
      seen.add(guid);
    }
  }

  state[feed.url] = [...seen];
  return newItems;
}

async function main() {
  const state = loadState();

  for (const feed of FEEDS) {
    try {
      const newItems = await checkFeed(feed, state);
      if (newItems.length > 0) {
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
