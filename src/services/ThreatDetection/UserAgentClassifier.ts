const AUTOMATION_PATTERN: RegExp = /HeadlessChrome|PhantomJS|Puppeteer|Playwright/i;
const NON_BROWSER_PATTERN: RegExp = /bot|crawler|spider|preview|monitor|facebookexternalhit|slurp|headless/i;

export function isAutomationUserAgent(userAgent: string): boolean {
    return AUTOMATION_PATTERN.test(userAgent);
}

export function isBrowserUserAgent(userAgent: string): boolean {
    return userAgent.startsWith('Mozilla/5.0')
        && isAutomationUserAgent(userAgent) === false
        && NON_BROWSER_PATTERN.test(userAgent) === false;
}
