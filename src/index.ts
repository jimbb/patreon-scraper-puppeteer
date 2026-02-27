import fs from 'fs-extra';
import https from 'https';
import http from 'http';
import path from 'path';
import { ElementHandle, Page } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import config from '../config';

const CREATOR: string = config.creator;
const SCRAPE_BY_YEAR: boolean = config.scrapeByYear;
const YEARS_TO_SCRAPE: string[] = (config as any).yearsToScrape ?? [];
const STOP_SCRAPE_INDEX: number = config.numPostsToScrape - 1;
const SCRAPE_COMMENTS: boolean = config.scrapeComments;
const SCRAPE_REPLIES: boolean = config.scrapeReplies;
const BTN_CLICK_MAX_RETRIES = 5;

const FILTER_BTN_LABEL = 'post-feed-consolidated-filters-toggle';
const APPLY_FILTER_BTN_LABEL = 'Apply filter';
const LOAD_REPLIES_LABEL = 'Load replies';

// const FILTER_BTN_LABEL = '文章摘要篩選條件切換按鈕';
// const APPLY_FILTER_BTN_LABEL = '套用篩選條件';
// const LOAD_REPLIES_LABEL = '載入回覆';

// Debugging options below

// Log debug information if true
const DEBUG = true;

// Process posts if true. Set to false to test pagination without processing posts
const PROCESS_POSTS = true;

// Only process posts with the following indices.
// Leave empty to process all posts
const WHITELISTED_POSTS: number[] = [];

puppeteer.use(StealthPlugin());

const mediaUrls: Set<string> = new Set();
const imageUrls: Set<string> = new Set();
const thirdPartyApiLinks: Set<string> = new Set();
const postTitles: Map<string, string> = new Map(); // postId -> title

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: path.join(__dirname, '../browser-data'),
  });

  try {
    if (!CREATOR || CREATOR === 'johndoe')
      throw new Error("Please set the creator's name in the config file.");
    if (!STOP_SCRAPE_INDEX || STOP_SCRAPE_INDEX < 0)
      throw new Error(
        'Please set a valid numPostsToScrape in the config file.'
      );
    const page = await browser.newPage();
    page.on('response', async response => {
      const url = response.url();
      if (/\.(mp3|mp4|m4a|wav|ogg|webm|flac)(\?|$)/i.test(url) && url.includes('patreonusercontent.com')) {
        mediaUrls.add(url);
        console.log(`Captured media URL: ${url.split('?')[0]}`);
      } else if (/patreon-media\/p\/post\/\d+/.test(url) && /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(url)) {
        imageUrls.add(url);
      } else if (url.includes('patreon.com/api/campaigns') && url.includes('/posts')) {
        try {
          const json = await response.json();
          const posts = Array.isArray(json?.data) ? json.data : (json?.data ? [json.data] : []);
          for (const post of posts) {
            const videoUrl = post?.attributes?.main_video_url;
            if (videoUrl && (videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be') || videoUrl.includes('vimeo.com'))) {
              thirdPartyApiLinks.add(videoUrl);
              console.log(`Captured video link: ${videoUrl}`);
            }
          }
        } catch (_) {}
      } else if (/patreon\.com\/api\/posts\/\d+/.test(url) && !url.includes('/comments')) {
        try {
          const json = await response.json();
          const post = json?.data;
          const videoUrl = post?.attributes?.main_video_url;
          if (videoUrl && (videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be') || videoUrl.includes('vimeo.com'))) {
            thirdPartyApiLinks.add(videoUrl);
            console.log(`Captured video link: ${videoUrl}`);
          }
        } catch (_) {}
      }
    });
    const baseDir = path.join(
      __dirname,
      '../dist',
      CREATOR,
      new Date().toISOString()
    );
    page.setDefaultTimeout(0);

    // await fs.remove(baseDir);
    await fs.ensureDir(baseDir);
    console.log(`Created directory: ${baseDir}`);

    console.log('Checking login status...');
    await page.goto('https://www.patreon.com/login');
    const isLoggedIn = await page.evaluate(() => !window.location.href.includes('/login'));
    if (!isLoggedIn) {
      console.log('Please log in to Patreon in the browser window, then wait...');
      await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 0 });
      console.log('Logged in successfully.');
    }
    // Clear any media captured during login navigation
    mediaUrls.clear();
    imageUrls.clear();
    thirdPartyApiLinks.clear();

    console.log(`Navigating to ${CREATOR} posts...`);
    await page.goto(`https://www.patreon.com/${CREATOR}/posts`);
    await page.waitForSelector('div[data-tag="post-card"]');

    const years: { label: string; filterIndex: number }[] = [];
    if (SCRAPE_BY_YEAR) {
      const filterBtn = await page.$(
        `button[aria-disabled="false"][data-tag="${FILTER_BTN_LABEL}"]`
      );
      if (!filterBtn) throw new Error('Could not find filter button');
      await (filterBtn as ElementHandle<HTMLButtonElement>).evaluate(el =>
        el.click()
      );
      await page.waitForSelector('[id*="filter-dialog"],[data-tag*="filter-dialog"],[role="dialog"]');
      const yearBtns = await page.$$('input[name="consolidated-date-filter"]');
      if (!yearBtns) throw new Error('Could not find year buttons');
      for (let i = 2; i < yearBtns.length; i++) {
        const yearBtn = yearBtns[i];
        const label = await yearBtn.evaluate(
          el => el.parentElement?.textContent
        );
        if (!label) throw new Error('Could not find year value');
        const filterIndex = await yearBtn.evaluate(el => parseInt(el.value));
        years.push({ label, filterIndex });
      }
    }
    if (years.length === 0) {
      years.push({ label: 'all', filterIndex: -1 });
    }
    if (YEARS_TO_SCRAPE.length > 0) {
      const filtered = years.filter(y => YEARS_TO_SCRAPE.some(f => y.label.includes(f)));
      years.length = 0;
      years.push(...filtered);
      console.log(`Filtering to years: ${years.map(y => y.label).join(', ')}`);
    }

    while (years.length > 0) {
      const yearEntry = years.shift();
      if (!yearEntry) throw new Error('Could not pop year');
      const { label: year, filterIndex } = yearEntry;
      if (year !== 'all') {
        const filterBtn = await page.$(
          `button[aria-disabled="false"][data-tag="${FILTER_BTN_LABEL}"]`
        );
        if (!filterBtn) throw new Error('Could not find filter button');
        filterBtn.evaluate(el => el.scrollIntoView());
        await (filterBtn as ElementHandle<HTMLButtonElement>).evaluate(el =>
          el.click()
        );
        await page.waitForSelector('[id*="filter-dialog"],[data-tag*="filter-dialog"],[role="dialog"]');
        const yearBtn = await page.$(
          `input[name="consolidated-date-filter"][value="${filterIndex}"]`
        );
        if (!yearBtn) throw new Error('Could not find year button');
        await yearBtn.evaluate(el => el.click());
        console.log(`Clicked filter for year ${year}.`);
        const applyBtn = await page.$(
          `button[label="${APPLY_FILTER_BTN_LABEL}"]`
        );
        if (!applyBtn) throw new Error('Could not find apply button');
        await applyBtn.evaluate(el => el.click());
        await page.waitForSelector('div[data-tag="post-card"]');
      }

      let hasMorePosts = true;
      let postIndexInCurrPage: number = 0;
      while (hasMorePosts) {
        // Dump page HTML for debugging selectors
        const html = await page.content();
        await fs.outputFile(path.join(baseDir, 'debug.html'), html);
        console.log('Dumped page HTML to debug.html');
        const postFeed = await page.$('div[data-cardlayout-edgeless]');
        if (!postFeed) throw new Error('Could not find post feed');

        const posts = (
          await page.$$('div[data-cardlayout-edgeless] > div')
        ).slice(postIndexInCurrPage);
        console.log(`Found ${posts.length} posts.`);
        // Extract titles for all visible posts
        const newTitles = await page.evaluate(() => {
          const result: Record<string, string> = {};
          document.querySelectorAll('div[data-tag="post-card"]').forEach(card => {
            const titleEl = card.querySelector('[data-tag="post-title"] a');
            const postId = (titleEl as HTMLAnchorElement | null)?.href?.match(/\/posts\/[^\/]+-(\d+)$/)?.[1]
              ?? (titleEl as HTMLAnchorElement | null)?.href?.match(/\/posts\/(\d+)$/)?.[1];
            const text = titleEl?.textContent?.trim();
            if (postId && text) result[postId] = text;
          });
          return result;
        });
        for (const [id, title] of Object.entries(newTitles)) {
          postTitles.set(id, title);
        }
        console.log(
          `Processing post ${postIndexInCurrPage} to ${
            postIndexInCurrPage + posts.length - 1
          }...`
        );
        if (PROCESS_POSTS) {
          for (let i = 0; i < posts.length; i++) {
            if (
              WHITELISTED_POSTS.length === 0 ||
              WHITELISTED_POSTS.includes(postIndexInCurrPage)
            ) {
              await processPost(page, postIndexInCurrPage);
            } else {
              console.log(`post ${postIndexInCurrPage}: Skipped.`);
            }
            postIndexInCurrPage++;
          }
        } else {
          postIndexInCurrPage += posts.length;
        }

        if (postIndexInCurrPage > STOP_SCRAPE_INDEX) {
          hasMorePosts = false;
          console.log(`Reached STOP_SCRAPE_INDEX of ${STOP_SCRAPE_INDEX}.`);
          break;
        }

        const postFeedParent = await postFeed.evaluateHandle(
          el => el.parentElement
        );
        if (!(postFeedParent instanceof ElementHandle))
          throw new Error('Could not find ul parent');

        const loadMoreButton = await (
          (await (postFeedParent as ElementHandle).evaluateHandle(
            el => el.lastElementChild
          )) as ElementHandle
        ).$('button');
        if (!loadMoreButton) {
          hasMorePosts = false;
          console.log('All posts loaded.');
          break;
        }

        console.log('Clicking button to load more posts...');
        await loadMoreButton.click();

        await page.waitForFunction(
          previousLength => {
            const postFeed = document.querySelector(
              'div[data-cardlayout-edgeless]'
            );
            if (!postFeed)
              throw new Error(
                'Could not find post feed after clicking load more'
              );
            return postFeed.children.length > previousLength + 1;
          },
          {},
          postIndexInCurrPage
        );
      }

      await captureSnapshot(page, baseDir, year);
      await downloadMediaFiles(baseDir, year);
    }
  } catch (error) {
    console.error(error);
    await new Promise(() => {}); // Keep browser open for debugging
  } finally {
    await browser.close();
    console.log('Browser closed.');
  }
})();

async function processPost(page: Page, index: number): Promise<void> {
  try {
    const post = (await page.$$('div[data-cardlayout-edgeless] > div'))[index];
    if (!post) throw new Error('Could not find post');
    await post.evaluate(el => el.scrollIntoView());

    // Extract post URL to check for YouTube/Vimeo embeds on the individual post page
    const postUrl = await post.evaluate(el => {
      const a = el.querySelector('[data-tag="post-title"] a') as HTMLAnchorElement | null;
      return a?.href || null;
    });
    if (postUrl) {
      const postPage = await page.browser().newPage();
      try {
        postPage.on('response', async response => {
          const url = response.url();
          if (/patreon\.com\/api\/posts\/\d+$/.test(url.split('?')[0])) {
            try {
              const json = await response.json();
              const videoUrl = json?.data?.attributes?.main_video_url;
              if (videoUrl && (videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be') || videoUrl.includes('vimeo.com'))) {
                thirdPartyApiLinks.add(videoUrl);
                console.log(`Post ${index}: Captured video link: ${videoUrl}`);
              }
            } catch (_) {}
          }
        });
        await postPage.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (_) {}
      await postPage.close();
    }

    console.log(`Post ${index}: Full post loaded.`);

    if (SCRAPE_COMMENTS) {
      await loadMoreComments(page, index);
    }
    if (SCRAPE_REPLIES) {
      await loadReplies(page, index);
    }
  } catch (error) {
    throw new Error(`Error occurred while processing post ${index}: ${error}`);
  }
}

async function loadMoreComments(page: Page, index: number): Promise<void> {
  let hasMoreComments = true;
  while (hasMoreComments) {
    try {
      const post = await getPostHandle(page, index);
      const loadMoreCommentsBtn = await post.$(
        'button[data-tag="loadMoreCommentsCta"]'
      );
      if (!loadMoreCommentsBtn) {
        hasMoreComments = false;
        console.log(`Post ${index}: All comments loaded.`);
        break;
      }

      await loadMoreCommentsBtn.evaluate(el => el.click());
      console.log(`Post ${index}: Clicked load more comments.`);

      await page.waitForFunction(
        (index: number) => {
          const post = document.querySelectorAll(
            'div[data-cardlayout-edgeless] > div'
          )[index];
          return (
            post.querySelector(
              'button[data-tag="loadMoreCommentsCta"][aria-disabled="true"]'
            ) === null
          );
        },
        {},
        index
      );
    } catch (error) {
      throw new Error(`Error occurred while loading comments: ${error}`);
    }
  }
}

async function loadReplies(page: Page, index: number): Promise<void> {
  let hasMoreReplies = true;
  const lastReplyCounts: Map<string, number> = new Map(); // Keep counts of how many times the same last reply appears to prevent infinite loops due to phoney load replies buttons

  while (hasMoreReplies) {
    try {
      const post = await getPostHandle(page, index);
      const btns = await post.$$(
        'div[data-tag="content-card-comment-thread-container"] button'
      );
      const loadRepliesBtns: ElementHandle<HTMLButtonElement>[] = [];

      const lastReplies = [];
      for (const btn of btns) {
        const textContent = await btn.evaluate(el => el.textContent);

        if (textContent === LOAD_REPLIES_LABEL) {
          const replyThread = await btn.evaluateHandle(
            el => el.parentElement?.parentElement
          );
          if (!(replyThread instanceof ElementHandle))
            throw new Error('Could not find reply thread');
          let lastReply = await (
            replyThread as ElementHandle<HTMLElement>
          ).evaluate(el => {
            const children = el.children;
            console.log(children);
            console.log(children[children.length - 2]);
            console.log(children[children.length - 2]?.textContent);
            return children[children.length - 2]?.textContent || '';
          });
          if (!lastReply) {
            console.info(
              `post ${index}: Could not find last reply of the reply thread - using the parent of the reply thread`
            );
            lastReply = await (
              replyThread as ElementHandle<HTMLElement>
            ).evaluate(el => {
              const parent = el.parentElement;
              return parent?.firstElementChild?.textContent || '';
            });
            if (!lastReply)
              throw new Error('Could not find text to be a reference point.');
          }

          lastReplies.push(lastReply);
          lastReplyCounts.set(
            lastReply,
            (lastReplyCounts.get(lastReply) || 0) + 1
          );

          if (lastReplyCounts.get(lastReply)! < BTN_CLICK_MAX_RETRIES) {
            loadRepliesBtns.push(btn);
          } else {
            console.log(
              `Post ${index}: Load replies button reached max retries, skipping.${
                DEBUG ? ' Last reply: ' + lastReply : ''
              }`
            );
          }
        }
      }

      if (loadRepliesBtns.length === 0) {
        hasMoreReplies = false;
        console.log(`Post ${index}: All replies loaded.`);
        break;
      }

      for (const [i, btn] of loadRepliesBtns.entries()) {
        await btn.evaluate(el => el.click());
        const lastReply = lastReplies[i];
        lastReplyCounts.set(lastReply, lastReplyCounts.get(lastReply)! + 1);
        console.log(
          `Post ${index}: Clicked load replies.${
            DEBUG ? ` Last reply: ${lastReply}` : ''
          }.`
        );

        await page.waitForFunction(
          (index: number) => {
            const post = document.querySelectorAll(
              'div[data-cardlayout-edgeless] > div'
            )[index];
            return post.querySelector('svg[aria-label="Loading"]') === null;
          },
          {},
          index
        );
      }
    } catch (error) {
      throw new Error(`Error occurred while loading replies: ${error}`);
    }
  }
}

async function getPostHandle(
  page: Page,
  index: number
): Promise<ElementHandle> {
  try {
    const ul = await page.$('div[data-cardlayout-edgeless]');
    if (!ul) throw new Error('Could not find post feed');
    const post = (await ul.$$('div'))[index];
    if (!post) throw new Error('Could not find post');
    post.evaluate(el => el.scrollIntoView());
    return post;
  } catch (error) {
    throw new Error(`Error occurred while getting post handle: ${error}`);
  }
}

async function captureSnapshot(page: Page, baseDir: string, year: string) {
  // Extract post titles, third-party links, and video sources
  const pageData = await page.evaluate(() => {
    const titles: Record<string, string> = {};
    const thirdPartyLinks: string[] = [];
    const videoSrcs: string[] = [];

    document.querySelectorAll('div[data-tag="post-card"]').forEach(card => {
      const titleEl = card.querySelector('[data-tag="post-title"] a');
      const postId = (titleEl as HTMLAnchorElement | null)?.href?.match(/\/posts\/[^\/]+-(\d+)$/)?.[1]
        ?? (titleEl as HTMLAnchorElement | null)?.href?.match(/\/posts\/(\d+)$/)?.[1];
      const text = titleEl?.textContent?.trim();
      if (postId && text) titles[postId] = text;

      // Capture YouTube/Vimeo iframes (rendered)
      card.querySelectorAll('iframe[src]').forEach(el => {
        const src = (el as HTMLIFrameElement).src;
        if (src) thirdPartyLinks.push(src);
      });

      // Capture video src
      card.querySelectorAll('video[src]').forEach(el => {
        const src = (el as HTMLVideoElement).src;
        if (src) videoSrcs.push(src);
      });
      card.querySelectorAll('video source[src]').forEach(el => {
        const src = (el as HTMLSourceElement).src;
        if (src) videoSrcs.push(src);
      });
    });

    // Search full page HTML for main_video_url (Patreon embeds post video URLs in JSON within the page)
    const pageHtml = document.documentElement.innerHTML;
    const videoUrlRegex = /"main_video_url":"(https?:\/\/(?:www\.)?(?:youtube\.com\/watch[^"]+|youtu\.be\/[^"]+|vimeo\.com\/[^"]+))"/g;
    let m;
    while ((m = videoUrlRegex.exec(pageHtml)) !== null) {
      thirdPartyLinks.push(m[1]);
    }

    return { titles, thirdPartyLinks, videoSrcs };
  });

  for (const [id, title] of Object.entries(pageData.titles)) {
    postTitles.set(id, title);
  }
  for (const src of pageData.videoSrcs) {
    mediaUrls.add(src);
  }

  // Save third-party links to a text file (from DOM + API responses)
  const allLinks = [...new Set([...pageData.thirdPartyLinks, ...thirdPartyApiLinks])];
  thirdPartyApiLinks.clear();
  if (allLinks.length > 0) {
    const linksFile = path.join(baseDir, `${year.replace(/\s+/g, '')}-links.txt`);
    const existing = await fs.pathExists(linksFile) ? await fs.readFile(linksFile, 'utf8') : '';
    const newLinks = allLinks.filter(l => !existing.includes(l));
    if (newLinks.length > 0) {
      await fs.appendFile(linksFile, newLinks.join('\n') + '\n');
      console.log(`Saved ${newLinks.length} third-party link(s) to ${linksFile}`);
    }
  }

  const cdp = await page.createCDPSession();
  const { data } = await cdp.send('Page.captureSnapshot', { format: 'mhtml' });
  const distLoc = path.join(baseDir, `${year.replace(/\s+/g, '')}.mhtml`);
  await fs.outputFile(distLoc, data);
  console.log(`Snapshot saved to ${distLoc}`);
}

async function downloadFile(url: string, dest: string, label: string): Promise<void> {
  await new Promise<void>(resolve => {
    const file = fs.createWriteStream(dest);
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, res => {
      if (res.statusCode === 200) {
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      } else {
        file.close();
        fs.remove(dest);
        console.warn(`Failed to download ${label}: HTTP ${res.statusCode}`);
        resolve();
      }
    }).on('error', err => {
      fs.remove(dest);
      console.warn(`Error downloading ${label}: ${err.message}`);
      resolve();
    });
  });
}

async function downloadMediaFiles(baseDir: string, year: string) {
  const yearSlug = year.replace(/\s+/g, '');
  const mediaDir = path.join(baseDir, `${yearSlug}-media`);
  await fs.ensureDir(mediaDir);

  // Download audio/video files
  if (mediaUrls.size > 0) {
    console.log(`Downloading ${mediaUrls.size} audio/video file(s)...`);
    for (const url of mediaUrls) {
      const ext = url.match(/\.(mp3|mp4|m4a|wav|ogg|webm|flac)/i)?.[1] || 'bin';
      const postId = url.match(/\/post\/(\d+)\//)?.[1] || Date.now().toString();
      const title = postTitles.get(postId);
      const safeName = title
        ? `${postId} - ${title.replace(/[\/\\:*?"<>|]/g, '_').substring(0, 80)}`
        : postId;
      const dest = path.join(mediaDir, `${safeName}.${ext}`);
      if (await fs.pathExists(dest)) { console.log(`Already downloaded: ${safeName}.${ext}`); continue; }
      await downloadFile(url, dest, `${safeName}.${ext}`);
      console.log(`Downloaded: ${safeName}.${ext}`);
    }
    mediaUrls.clear();
  }

  // Download post images
  if (imageUrls.size > 0) {
    const imgDir = path.join(mediaDir, 'images');
    await fs.ensureDir(imgDir);
    console.log(`Downloading ${imageUrls.size} image(s)...`);
    for (const url of imageUrls) {
      const ext = url.match(/\.(jpg|jpeg|png|gif|webp)/i)?.[1] || 'jpg';
      const postId = url.match(/\/post\/(\d+)\//)?.[1] || Date.now().toString();
      const fileHash = url.match(/\/post\/\d+\/([a-f0-9]+)\//)?.[1]?.substring(0, 8) || Date.now().toString();
      const title = postTitles.get(postId);
      const safeName = title
        ? `${postId}_${fileHash} - ${title.replace(/[\/\\:*?"<>|]/g, '_').substring(0, 60)}`
        : `${postId}_${fileHash}`;
      const dest = path.join(imgDir, `${safeName}.${ext}`);
      if (await fs.pathExists(dest)) continue;
      await downloadFile(url, dest, `${safeName}.${ext}`);
      console.log(`Downloaded image: ${safeName}.${ext}`);
    }
    imageUrls.clear();
  }
}
