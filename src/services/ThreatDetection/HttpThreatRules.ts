import HttpThreatCategory from '../../types/enums/HttpThreatCategory';
import { HttpThreat, HttpThreatInput } from '../../types/interfaces/HttpThreatDetectedEvent';
import {isBrowserUserAgent} from './UserAgentClassifier';

export interface HttpThreatRequestText {
    path: string;
    query: string;
    userAgent: string;
    referer: string;
    method: string;
    host: string;
    origin: string;
    clientHints: string;
    fromInternalNetwork: boolean;
}

export interface HttpThreatRuleContext {
    allowedOrigin: string;
    allowedHosts: ReadonlySet<string>;
    disabledCategories: ReadonlySet<HttpThreatCategory>;
}

interface HttpThreatRule {
    category: HttpThreatCategory;
    rule: string;
    inputs: readonly HttpThreatInput[];
    pattern: RegExp;
}

const INPUT_READERS: Record<HttpThreatInput, (text: HttpThreatRequestText) => string> = {
    path: (text: HttpThreatRequestText): string => text.path,
    query: (text: HttpThreatRequestText): string => text.query,
    'user-agent': (text: HttpThreatRequestText): string => text.userAgent,
    referer: (text: HttpThreatRequestText): string => text.referer,
    method: (text: HttpThreatRequestText): string => text.method,
    host: (text: HttpThreatRequestText): string => text.host,
    origin: (text: HttpThreatRequestText): string => text.origin,
    'client-hints': (text: HttpThreatRequestText): string => text.clientHints,
};

const HEADLESS_CLIENT_HINT_PATTERN: RegExp = /HeadlessChrome/i;
const CHROMIUM_CLIENT_HINT_PATTERN: RegExp = /Chrome|Chromium|CriOS|Edg|OPR|SamsungBrowser/i;
const SAFARI_USER_AGENT_PATTERN: RegExp = /Version\/.*Safari\//i;
const FIREFOX_USER_AGENT_PATTERN: RegExp = /Firefox\//i;

const RULES: readonly HttpThreatRule[] = [
    {
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-script-file',
        inputs: ['path'],
        pattern: /\.(?:php\d?|phtml|asp|aspx|jsp|jspx)\b/i,
    },
    {
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-wordpress',
        inputs: ['path'],
        pattern: /(?:^|\/)(?:wp-admin|wp-content|wp-includes|wp-login|xmlrpc\.php)(?:[/.#]|$)/i,
    },
    {
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-phpmyadmin',
        inputs: ['path'],
        pattern: /(?:^|\/)phpmyadmin(?:[/.]|$)/i,
    },
    {
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-cgi',
        inputs: ['path'],
        pattern: /(?:^|\/)cgi-bin(?:[/.]|$)/i,
    },
    {
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-actuator',
        inputs: ['path'],
        pattern: /(?:^|\/)actuator(?:[/.]|$)/i,
    },
    {
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-solr',
        inputs: ['path'],
        pattern: /(?:^|\/)solr(?:[/.]|$)/i,
    },
    {
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-phpunit',
        inputs: ['path'],
        pattern: /(?:^|\/)vendor\/phpunit(?:[/.]|$)/i,
    },
    {
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-php-cgi',
        inputs: ['path'],
        pattern: /(?:^|\/)php-cgi(?:[/.]|$)/i,
    },
    {
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-php-include',
        inputs: ['path', 'query'],
        pattern: /(?:allow_url_include|php:\/\/input)/i,
    },
    {
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-server-path',
        inputs: ['path'],
        pattern: /(?:^|\/)(?:server-status|_ignition|telescope|_profiler|hnap1|boaform|gponform)(?:[/.]|$)/i,
    },
    {
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-dotenv',
        inputs: ['path'],
        pattern: /(?:^|\/)\.env(?:[./]|$)/i,
    },
    {
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-git',
        inputs: ['path'],
        pattern: /(?:^|\/)\.git(?:[./]|$)/i,
    },
    {
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-vcs',
        inputs: ['path'],
        pattern: /(?:^|\/)\.(?:svn|hg)(?:[./]|$)/i,
    },
    {
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-cloud',
        inputs: ['path'],
        pattern: /(?:^|\/)(?:\.aws|\.ssh)(?:[./]|$)|(?:^|\/)id_rsa(?:[._]|$)/i,
    },
    {
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-backup',
        inputs: ['path'],
        pattern: /\.(?:bak|sql|old|backup)\b|(?:^|\/)backup(?:[/.]|$)/i,
    },
    {
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-ds-store',
        inputs: ['path'],
        pattern: /(?:^|\/)\.ds_store$/i,
    },
    {
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-config',
        inputs: ['path'],
        pattern: /(?:^|\/)(?:config\.json|wp-config(?:\.php)?)(?:[/?#]|$)/i,
    },
    {
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-project-file',
        inputs: ['path'],
        pattern:
            /(?:^|\/)(?:sftp-config\.json|web\.config|\.npmrc|docker-compose\.ya?ml|\.htaccess)(?:[/.]|$)|(?:^|\/)\.vscode\/sftp\.json/i,
    },
    {
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-union-select',
        inputs: ['path', 'query'],
        pattern: /\bunion(?:[\s/*]+all)?[\s/*]+select\b/i,
    },
    {
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-error-function',
        inputs: ['path', 'query'],
        pattern: /\b(?:extractvalue|updatexml|elt)\s*\(/i,
    },
    {
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-timing-function',
        inputs: ['path', 'query'],
        pattern: /\b(?:sleep|pg_sleep|benchmark)\s*\(/i,
    },
    {
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-hex-concat',
        inputs: ['path', 'query'],
        pattern: /\bconcat\s*\(\s*0x[0-9a-f]{1,64}/i,
    },
    {
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-order-by-comment',
        inputs: ['path', 'query'],
        pattern: /\border\s+by\s+\d{1,10}\s*(?:--|#|\/\*)/i,
    },
    {
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-boolean-injection',
        inputs: ['path', 'query'],
        pattern:
            /['"`)]\s*(?:\/\*[\s\S]{0,40}?\*\/\s*)?(?:and|or)\b\s*(?:\/\*[\s\S]{0,40}?\*\/\s*)?[a-z0-9'"`(]{1,40}\s*=\s*[a-z0-9'"`)]{1,40}/i,
    },
    {
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-numeric-boolean',
        inputs: ['path', 'query'],
        pattern: /\b\d{1,10}\s+(?:and|or)\s+\d{1,10}\s*=\s*\d{1,10}\b/i,
    },
    {
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-comment-keyword',
        inputs: ['path', 'query'],
        pattern:
            /\b(?:and|or|union|select|where|order|by)\s*\/\*[\s\S]{0,40}?\*\/|\/\*[\s\S]{0,40}?\*\/\s*(?:and|or|union|select|where|order|by)\b/i,
    },
    {
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-stacked-query',
        inputs: ['path', 'query'],
        pattern: /;\s*(?:select|drop|insert|update|delete)\b/i,
    },
    {
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-waitfor-delay',
        inputs: ['path', 'query'],
        pattern: /\bwaitfor\s+delay\b/i,
    },
    {
        category: HttpThreatCategory.PathTraversal,
        rule: 'traversal-parent-directory',
        inputs: ['path', 'query'],
        pattern: /\.\.[\\/]/,
    },
    {
        category: HttpThreatCategory.PathTraversal,
        rule: 'traversal-system-file',
        inputs: ['path', 'query'],
        pattern: /(?:^|[\\/])(?:etc[\\/](?:passwd|shadow|hosts|group)|proc[\\/]self)|\b(?:win|boot)\.ini\b/i,
    },
    {
        category: HttpThreatCategory.PathTraversal,
        rule: 'traversal-file-uri',
        inputs: ['path', 'query'],
        pattern: /\bfile:[\\/]{2}/i,
    },
    {
        category: HttpThreatCategory.Xss,
        rule: 'xss-script-tag',
        inputs: ['path', 'query'],
        pattern: /<\/?script\b/i,
    },
    {
        category: HttpThreatCategory.Xss,
        rule: 'xss-svg-tag',
        inputs: ['path', 'query'],
        pattern: /<\s*svg\b/i,
    },
    {
        category: HttpThreatCategory.Xss,
        rule: 'xss-event-handler',
        inputs: ['path', 'query'],
        pattern:
            /(?:^|[=\s'"`/<>])on(?:error|load|unload|mouseover|mouseenter|mouseleave|mousemove|mousedown|mouseup|mouseout|focus|focusin|focusout|blur|click|dblclick|toggle|animationstart|animationend|pointerover|pointerdown|pointerup|pointerenter|pointerleave|begin|start|end|wheel|input|change|submit|keydown|keyup|keypress|beforeprint|afterprint|select|drag|dragstart|drop|contextmenu)\s*=/i,
    },
    {
        category: HttpThreatCategory.Xss,
        rule: 'xss-javascript-uri',
        inputs: ['path', 'query'],
        pattern: /\bjavascript\s*:/i,
    },
    {
        category: HttpThreatCategory.Xss,
        rule: 'xss-alert-call',
        inputs: ['path', 'query'],
        pattern: /\balert\s*\(/i,
    },
    {
        category: HttpThreatCategory.Xss,
        rule: 'xss-document-cookie',
        inputs: ['path', 'query'],
        pattern: /\bdocument\s*\.\s*cookie\b/i,
    },
    {
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-jndi',
        inputs: ['path', 'query', 'user-agent', 'referer'],
        pattern: /\$\{jndi\s*:/i,
    },
    {
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-jndi-obfuscated',
        inputs: ['path', 'query', 'user-agent', 'referer'],
        pattern: /\$\{[^}]{0,40}\$\{/,
    },
    {
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-template-expression',
        inputs: ['path', 'query', 'user-agent', 'referer'],
        pattern:
            /\{\{\s*\d{1,10}\s*[*/+-]\s*\d{1,10}\s*\}\}|\$\{\s*\d{1,10}\s*[*/+-]\s*\d{1,10}\s*\}/,
    },
    {
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-shell-chain',
        inputs: ['path', 'query', 'user-agent', 'referer'],
        pattern: /;\s*(?:wget|curl)\b/i,
    },
    {
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-substitution',
        inputs: ['path', 'query', 'user-agent', 'referer'],
        pattern: /\$\([^()]{0,80}\)/,
    },
    {
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-backtick',
        inputs: ['path', 'query', 'user-agent', 'referer'],
        pattern: /`(?:id|whoami|uname|cat|ls|wget|curl|ps|nc)\b[^`]{0,80}`/i,
    },
    {
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-pipe-shell',
        inputs: ['path', 'query', 'user-agent', 'referer'],
        pattern: /\|\s*(?:sh|bash|zsh)\b/i,
    },
    {
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-shell-binary',
        inputs: ['path', 'query', 'user-agent', 'referer'],
        pattern: /(?:\/bin\/(?:sh|bash|zsh|dash)\b|cmd\.exe\b)/i,
    },
    {
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-shellshock',
        inputs: ['path', 'query', 'user-agent', 'referer'],
        pattern: /\(\s*\)\s*\{[^}]{0,40}\}\s*;/,
    },
    {
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-sqlmap',
        inputs: ['user-agent'],
        pattern: /\bsqlmap\b/i,
    },
    {
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-web-scanner',
        inputs: ['user-agent'],
        pattern:
            /\b(?:nikto|nuclei|wpscan|dirbuster|gobuster|ffuf|feroxbuster|wfuzz|l9explore|acunetix|netsparker|havij)(?![a-z0-9])|\bfuzz\s+faster\s+u\s+fool\b/i,
    },
    {
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-network-scanner',
        inputs: ['user-agent'],
        pattern: /\b(?:masscan|nmap|zgrab)\b/i,
    },
    {
        category: HttpThreatCategory.MalformedRequest,
        rule: 'malformed-method',
        inputs: ['method'],
        pattern: /^(?:trace|propfind)$/i,
    },
];

export class HttpThreatRules {
    public static match(text: HttpThreatRequestText, context: HttpThreatRuleContext): HttpThreat[] {
        const threats: HttpThreat[] = [];
        const seen: Set<string> = new Set();

        for (const rule of RULES) {
            if (context.disabledCategories.has(rule.category)) {
                continue;
            }

            for (const input of rule.inputs) {
                const value: string = INPUT_READERS[input](text);

                if (value === '' || rule.pattern.test(value) === false) {
                    continue;
                }

                const key: string = rule.category + '\u0000' + rule.rule + '\u0000' + input;

                if (seen.has(key) === false) {
                    seen.add(key);
                    threats.push({ category: rule.category, rule: rule.rule, input: input });
                }
            }
        }

        if (
            context.disabledCategories.has(HttpThreatCategory.UserAgentSpoofing) === false
            && text.clientHints !== ''
            && isBrowserUserAgent(text.userAgent)
        ) {
            if (
                HEADLESS_CLIENT_HINT_PATTERN.test(text.clientHints)
                && HEADLESS_CLIENT_HINT_PATTERN.test(text.userAgent) === false
            ) {
                threats.push({
                    category: HttpThreatCategory.UserAgentSpoofing,
                    rule: 'spoofing-client-hints-headless',
                    input: 'client-hints',
                });
            }

            const safariWithoutChromium: boolean = SAFARI_USER_AGENT_PATTERN.test(text.userAgent)
                && CHROMIUM_CLIENT_HINT_PATTERN.test(text.userAgent) === false;

            if (safariWithoutChromium || FIREFOX_USER_AGENT_PATTERN.test(text.userAgent)) {
                threats.push({
                    category: HttpThreatCategory.UserAgentSpoofing,
                    rule: 'spoofing-client-hints-non-chromium',
                    input: 'client-hints',
                });
            }
        }

        if (context.disabledCategories.has(HttpThreatCategory.MalformedRequest) === false) {
            if (text.origin !== '' && text.origin !== context.allowedOrigin) {
                threats.push({
                    category: HttpThreatCategory.MalformedRequest,
                    rule: 'malformed-origin',
                    input: 'origin',
                });
            }

            const host: string = text.host.toLowerCase();

            if (text.fromInternalNetwork === false && host !== '' && context.allowedHosts.has(host) === false) {
                threats.push({
                    category: HttpThreatCategory.MalformedRequest,
                    rule: 'malformed-host',
                    input: 'host',
                });
            }
        }

        return threats;
    }

    public static hostWithoutPort(hostHeader: string): string {
        const host: string = hostHeader.trim().toLowerCase();

        if (host.startsWith('[')) {
            const closingBracket: number = host.indexOf(']');

            if (closingBracket !== -1) {
                return host.slice(1, closingBracket);
            }
        }

        const firstColon: number = host.indexOf(':');

        if (firstColon !== -1 && firstColon === host.lastIndexOf(':')) {
            return host.slice(0, firstColon);
        }

        return host;
    }
}

export default HttpThreatRules;
