const RANDOM_LETTERS: string = 'lsahoofgomkdyursbtrsbtgvudsjkddr';
const RANDOM_TOKEN: string = '3nidzk';
const RANDOM_NUMBER: number = 4912;

const QUOTING_SUFFIXES: readonly string[] = ['', "'", '"', '`', "%'", '%"', ')', "')", '")', '`)', "%')", '%")'];
const ORDER_BY_SUFFIXES: readonly string[] = ['', "'"];
const UNION_SUFFIXES: readonly string[] = ['', "'"];
const UNION_SELECT_LISTS: readonly string[] = [
    `'${RANDOM_LETTERS}'`,
    `'${RANDOM_LETTERS}',NULL`,
    `NULL,'${RANDOM_LETTERS}'`,
];

function encodeScanValue(value: string): string {
    return value.replace(/[^A-Za-z0-9\-._~]/g, (character: string): string => {
        return '%' + character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
    });
}

function appendPayloadVariants(queries: string[], payload: string): void {
    const encoded: string = encodeScanValue(payload);

    queries.push(`page=${encoded}&limit=48`);
    queries.push(`page=1&limit=${encoded}`);
}

function buildScanQueries(): string[] {
    const queries: string[] = [];

    for (const suffix of QUOTING_SUFFIXES) {
        appendPayloadVariants(
            queries,
            `48${suffix} AND EXTRACTVALUE(${RANDOM_NUMBER},CONCAT(0x7e,((SELECT (ELT(${RANDOM_NUMBER}=${RANDOM_NUMBER},1)))),0x7e))-- -`,
        );
    }

    for (const suffix of ORDER_BY_SUFFIXES) {
        for (const orderNumber of [1, 1000]) {
            appendPayloadVariants(queries, `1${suffix} ORDER BY ${orderNumber}-- -`);
        }
    }

    for (const suffix of UNION_SUFFIXES) {
        for (const selectList of UNION_SELECT_LISTS) {
            appendPayloadVariants(queries, `-48${suffix} UNION ALL SELECT ${selectList}-- ${RANDOM_TOKEN}`);
        }
    }

    appendPayloadVariants(
        queries,
        `) AND (1045390511=1045390511 UNION ALL SELECT '${RANDOM_LETTERS}'-- ${RANDOM_TOKEN}`,
    );
    appendPayloadVariants(queries, "1' AND 1=1 UNION SELECT NULL-- -");
    appendPayloadVariants(queries, ')/**/aND/**/(312447629=312447629\'');

    return queries;
}

export const SQL_INJECTION_SCAN_QUERIES: string[] = buildScanQueries();

const GOOGLEBOT_USER_AGENT: string =
    'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/41.0.2272.96 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const BINGBOT_USER_AGENT: string = 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)';
const UPTIME_ROBOT_USER_AGENT: string =
    'Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)';
const U_MONITOR_USER_AGENT: string = 'Mozilla/5.0 (compatible; uMonitor/1.0; +https://umonitor.eu/)';
export const CHROME_USER_AGENT: string =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
export const FIREFOX_USER_AGENT: string = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
export const OPERA_USER_AGENT: string =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/114.0.0.0';
export const IPHONE_SAFARI_USER_AGENT: string =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
    'Version/26.0 Mobile/15E148 Safari/604.1';
export const HEADLESS_CHROME_USER_AGENT: string =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'HeadlessChrome/138.0.7204.23 Safari/537.36';

export const LEGIT_REQUESTS: { path: string; query: string; userAgent: string }[] = [
    { path: '/home', query: '', userAgent: '' },
    { path: '/articles/travel', query: 'page=7&limit=48', userAgent: CHROME_USER_AGENT },
    { path: '/articles/tag/bw', query: 'page=1&limit=48', userAgent: FIREFOX_USER_AGENT },
    { path: '/u/sample_user', query: '', userAgent: OPERA_USER_AGENT },
    { path: '/users/berlin/designers', query: '', userAgent: CHROME_USER_AGENT },
    { path: '/help/faq', query: 'filter=solved', userAgent: FIREFOX_USER_AGENT },
    { path: '/news', query: '', userAgent: CHROME_USER_AGENT },
    { path: '/user/get-token', query: '', userAgent: CHROME_USER_AGENT },
    { path: '/sitemap/pages.xml', query: '', userAgent: GOOGLEBOT_USER_AGENT },
    { path: '/llms.txt', query: '', userAgent: BINGBOT_USER_AGENT },
    {
        path: '/s/abcdefghijklmnopqrstuvwxyz1234/files/1/thumb',
        query: '',
        userAgent: 'facebookexternalhit/1.1',
    },
    { path: '/search', query: 'q=o%27neil', userAgent: CHROME_USER_AGENT },
    { path: '/search', query: 'q=rock%27n%27roll', userAgent: CHROME_USER_AGENT },
    { path: '/search', query: 'q=czarno-bia%C5%82e%20portrety', userAgent: FIREFOX_USER_AGENT },
    { path: '/search', query: 'q=union%20jack', userAgent: CHROME_USER_AGENT },
    { path: '/search', query: 'q=select%20portrety', userAgent: CHROME_USER_AGENT },
    { path: '/search', query: 'q=order%20by%20date', userAgent: CHROME_USER_AGENT },
    { path: '/search', query: 'q=script%20na%20spotkanie', userAgent: CHROME_USER_AGENT },
    { path: '/search', query: 'q=100%25', userAgent: CHROME_USER_AGENT },
    { path: '/search', query: 'q=color/*red*/', userAgent: CHROME_USER_AGENT },
    { path: '/search', query: 'q=portret+online%3Dtak', userAgent: CHROME_USER_AGENT },
    { path: '/articles/travel', query: 'only=portraits', userAgent: FIREFOX_USER_AGENT },
    { path: '/articles/travel', query: 'onlyMine=true&page=2', userAgent: FIREFOX_USER_AGENT },
    { path: '/articles/tag/bw', query: 'page=1 and 2', userAgent: CHROME_USER_AGENT },
    { path: '/search', query: 'q=%23bw%20%40alice', userAgent: CHROME_USER_AGENT },
    { path: '/home', query: '', userAgent: GOOGLEBOT_USER_AGENT },
    { path: '/home', query: '', userAgent: BINGBOT_USER_AGENT },
    { path: '/home', query: '', userAgent: 'facebookexternalhit/1.1' },
    { path: '/home', query: '', userAgent: UPTIME_ROBOT_USER_AGENT },
    { path: '/home', query: '', userAgent: U_MONITOR_USER_AGENT },
    { path: '/home', query: '', userAgent: CHROME_USER_AGENT },
    { path: '/home', query: '', userAgent: FIREFOX_USER_AGENT },
    { path: '/home', query: '', userAgent: OPERA_USER_AGENT },
];
