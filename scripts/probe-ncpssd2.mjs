// journal.js had no url: patterns; print its fetch/ajax calls + look for journal handler endpoints.
const js = await fetch('https://www.ncpssd.org/js/web/journal.js', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) }).then((r) => r.text());
const calls = js.match(/(\$\.ajax|\$\.post|\$\.get|fetch|axios)[\s\S]{0,250}?/gu) ?? [];
console.log(js.replace(/\s+/g, ' ').slice(0, 2600));
