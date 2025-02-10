/**
 * 🦉 Bubo RSS Reader
 * ====
 * Dead, dead simple feed reader that renders an HTML
 * page with links to content from feeds organized by site
 *
 */

import Parser from 'rss-parser';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { template } from './template.js';

const WRITE = process.argv.includes('--write');
const USE_CACHE = !WRITE && process.argv.includes('--cached');

const CACHE_PATH = './src/cache.json';
const OUTFILE_PATH = './output/index.html';
const CONTENT_TYPES = [
  'application/json',
  'application/atom+xml',
  'application/rss+xml',
  'application/xml',
  'application/octet-stream',
  'text/xml'
];

const config = readCfg('./src/config.json');
const feeds = USE_CACHE ? {} : readCfg('./src/feeds.json');
const cache = USE_CACHE ? readCfg(CACHE_PATH) : {};

await build({ config, feeds, cache, writeCache: WRITE });

async function build({ config, feeds, cache, writeCache = false }) {
  let allItems = cache.allItems || [];
  const parser = new Parser();
  const errors = [];
  const groupContents = {};

  for (const groupName in feeds) {
    groupContents[groupName] = [];

    const results = await Promise.allSettled(
      Object.values(feeds[groupName]).map(url =>
        fetch(url, { method: 'GET' })
          .then(res => [url, res])
          .catch(e => {
            throw [url, e];
          })
      )
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        const [url, error] = result.reason;
        errors.push(url);
        console.error(`Error fetching ${url}:\n`, error);
        continue;
      }

      const [url, response] = result.value;

      try {
        // e.g., `application/xml; charset=utf-8` -> `application/xml`
        const contentType = response.headers.get('content-type').split(';')[0];

        if (!CONTENT_TYPES.includes(contentType))
          throw Error(`Feed at ${url} has invalid content-type.`)

        const body = await response.text();
        const contents = typeof body === 'string'
          ? await parser.parseString(body)
          : body;
        const isRedditRSS = contents.feedUrl && contents.feedUrl.includes("reddit.com/r/");

        if (!contents.items.length === 0)
          throw Error(`Feed at ${url} contains no items.`)

        contents.feed = url;
        contents.title = contents.title || contents.link;
        groupContents[groupName].push(contents);

        // item sort & normalization
        contents.items.sort(byDateSort);
        contents.items.forEach((item) => {
          // 1. try to normalize date attribute naming
          const dateAttr = item.pubDate || item.isoDate || item.date || item.published;
          item.timestamp = new Date(dateAttr).toLocaleDateString();

          // 2. correct link url if it lacks the hostname
          if (item.link && item.link.split('http').length === 1) {
            item.link =
              // if the hostname ends with a /, and the item link begins with a /
              contents.link.slice(-1) === '/' && item.link.slice(0, 1) === '/'
                ? contents.link + item.link.slice(1)
                : contents.link + item.link;
          }

          // 3. parse subreddit feed comments
          if (isRedditRSS && item.contentSnippet && item.contentSnippet.startsWith('submitted by    ')) {
            // matches anything between double quotes, like `<a href="matches this">foo</a>`
            const quotesContentMatch = /(?<=")(?:\\.|[^"\\])*(?=")/g;
            let [_submittedBy, _userLink, contentLink, commentsLink] = item.content.split('<a href=');
            item.link = contentLink.match(quotesContentMatch)[0];
            item.comments = commentsLink.match(quotesContentMatch)[0];
          }

          // 4. redirects
          if (config.redirects) {
            // need to parse hostname methodically due to unreliable feeds
            const url = new URL(item.link);
            const tokens = url.hostname.split('.');
            const host = tokens[tokens.length - 2];
            const redirect = config.redirects[host];
            if (redirect) item.link = `https://${redirect}${url.pathname}${url.search}`;
          }


			// 5. escape any html in the title
			if (typeof item.title === 'string') {
				try {
					item.title = escapeHtml(item.title);
				} catch (error) {
					console.error('Error escaping HTML in title:', error);
				}
			} else {
				console.log('Title is not a string:', item.title);
				item.title = '(NO TITLE ON THIS ITEM)'
					console.log('item.link:', item.link);
				console.log('item.contentSnippet:', item.contentSnippet);
				console.log(Object.keys(item));
			}
		});

        // add to allItems
        allItems = [...allItems, ...contents.items];
      } catch (e) {
        console.error(e);
        errors.push(url)
      }
    }
  }

  const groups = cache.groups || Object.entries(groupContents);

  if (writeCache) {
    writeFileSync(
      resolve(CACHE_PATH),
      JSON.stringify({ groups, allItems }),
      'utf8'
    );
  }

  // for each group, sort the feeds
  // sort the feeds by comparing the isoDate of the first items of each feed
  groups.forEach(([_groupName, feeds]) => {
    feeds.sort((a, b) => byDateSort(a.items[0], b.items[0]));
  });

  // sort `all articles` view
  allItems.sort((a, b) => byDateSort(a, b));

  const now = getNowDate(config.timezone_offset).toString();
  const html = template({ allItems, groups, now, errors });

  writeFileSync(resolve(OUTFILE_PATH), html, { encoding: 'utf8' });
  console.log(`Reader built successfully at: ${OUTFILE_PATH}`);
}

/**
 * utils
 */
function parseDate(item) {
  let date = item
    ? (item.isoDate || item.pubDate)
    : undefined;

  return date ? new Date(date) : undefined;
}

function byDateSort(dateStrA, dateStrB) {
  const [aDate, bDate] = [parseDate(dateStrA), parseDate(dateStrB)];
  if (!aDate || !bDate) return 0;
  return bDate - aDate;
}

function getNowDate(offset = 0) {
  let d = new Date();
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  d = new Date(utc + (3600000 * offset));
  return d;
}

function readCfg(path) {
  let contents, json;

  try {
    contents = readFileSync(resolve(path), { encoding: 'utf8' });
  } catch (e) {
    console.warn(`Warning: Config at ${path} does not exist`);
    return {};
  }

  try {
    json = JSON.parse(contents);
  } catch (e) {
    console.error('Error: Config is Invalid JSON: ' + path);
    process.exit(1);
  }

  return json;
}


function escapeHtml(html) {
  const entities = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&apos;',
    '’': '&apos;',
    '‘': '&apos;',
    '“': '&quot;',
    '”': '&quot;',
    '<cite>': '&quot;',
    '</cite>': '&quot;',
    '&#8217;': '&apos;',
    '&#8216;': '&apos;',
    '&rsquo;': '&apos;',
    '&lsquo;': '&apos;',
  };

  return html.replace(/&(#8217|#8216);|&rsquo;|&lsquo;|&(?!([a-zA-Z0-9#]+;))|"|'|’|‘|“|”|<cite>|<\/cite>|<(?!cite)|(?!<cite)>/g, function(match) {
      const replacement = entities[match] || match;
      // console.log(`Matched: ${match}, Replaced with: ${replacement}`);
      return replacement;
  });
}
