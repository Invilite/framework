export enum HttpThreatCategory {
    ForeignTechnologyProbe = 'foreign-technology-probe',
    SecretFileProbe = 'secret-file-probe',
    SqlInjection = 'sql-injection',
    PathTraversal = 'path-traversal',
    Xss = 'xss',
    CommandInjection = 'command-injection',
    ScannerUserAgent = 'scanner-user-agent',
    MalformedRequest = 'malformed-request',
    UserAgentSpoofing = 'user-agent-spoofing',
}

export default HttpThreatCategory;
