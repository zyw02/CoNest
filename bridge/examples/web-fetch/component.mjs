// web-fetch component for dsh-bridge
// Fetch a URL and extract clean readable text.
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

function fetchUrl(targetUrl, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const client = url.protocol === 'https:' ? https : http;

    const req = client.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      timeout: timeoutMs,
      maxRedirects: 3,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, targetUrl).toString();
        fetchUrl(redirectUrl, timeoutMs).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function stripHtml(html) {
  // Remove script and style blocks
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Extract links before stripping tags
  const links = [];
  const linkRegex = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRegex.exec(text)) !== null) {
    const href = m[1];
    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      links.push(href);
    }
  }

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Convert block elements to newlines, then strip remaining tags
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text, links: links.slice(0, 20) };
}

export default {
  name: 'web-fetch',
  inject: ['bridgeCapabilities'],
  apply(ctx, config) {
    ctx.bridgeCapabilities.register(ctx, 'fetch_url', async (args, invocation) => {
      const { url } = args;
      const maxChars = args.maxChars || 20000;
      invocation.progress(`Fetching ${url}`);

      try {
        const { statusCode, body } = await fetchUrl(url);
        invocation.progress(`Received ${body.length} bytes, extracting content...`);

        if (statusCode !== 200) {
          return {
            url, statusCode, title: '', text: '', textLength: 0,
            links: [], error: `HTTP ${statusCode}`,
          };
        }

        const { title, text, links } = stripHtml(body);
        const cappedText = text.length > maxChars ? text.slice(0, maxChars) + '\n... [truncated]' : text;

        return {
          url,
          statusCode,
          title,
          text: cappedText,
          textLength: text.length,
          links,
        };
      } catch (err) {
        return {
          url, statusCode: 0, title: '', text: '', textLength: 0,
          links: [], error: err.message,
        };
      }
    });
  },
};
