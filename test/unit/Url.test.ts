import {Url} from "../../src/utils/Url";
import {Env} from "../../src/utils/Env";

describe("Url.join", () => {
    it("usuwa nadmiarowe ukośniki na styku części", () => {
        expect(Url.join('https://example.com/', '/user/password-reset')).toBe('https://example.com/user/password-reset');
        expect(Url.join('https://example.com', 'user', 'activate')).toBe('https://example.com/user/activate');
        expect(Url.join('https://example.com//', '//avatars//', '/83/cd/x.jpg')).toBe('https://example.com/avatars/83/cd/x.jpg');
    });
    it("zachowuje protokół i port", () => {
        expect(Url.join('http://127.0.0.1:8081/', 'calendar')).toBe('http://127.0.0.1:8081/calendar');
    });
    it("zwija podwójne ukośniki w ścieżce, ale nie rusza zapytania ani kotwicy", () => {
        expect(Url.join('https://a.example', '/user//login?redirect=https://b.example//x#a//b'))
            .toBe('https://a.example/user/login?redirect=https://b.example//x#a//b');
        expect(Url.join('https://a.example/', '/calendar#upcoming')).toBe('https://a.example/calendar#upcoming');
    });
    it("pomija puste części i zachowuje końcowy ukośnik ostatniej części", () => {
        expect(Url.join('https://a.example', '', null, undefined, 'x')).toBe('https://a.example/x');
        expect(Url.join('https://a.example', '/')).toBe('https://a.example/');
        expect(Url.join('https://a.example', 'profiles/')).toBe('https://a.example/profiles/');
    });
    it("działa z bazą względną (host-relative)", () => {
        expect(Url.join('/media/', '/avatars', 'x.jpg')).toBe('/media/avatars/x.jpg');
        expect(Url.join('', '/user/login')).toBe('/user/login');
    });
    it("liczby jako części", () => {
        expect(Url.join('https://a.example', 'articles/item', 42)).toBe('https://a.example/articles/item/42');
    });
});

describe("Url.trimTrailingSlash", () => {
    it("usuwa końcowe ukośniki, zostawia sam protokół i ścieżkę", () => {
        expect(Url.trimTrailingSlash('https://example.com/')).toBe('https://example.com');
        expect(Url.trimTrailingSlash('http://203.0.113.156:8888//')).toBe('http://203.0.113.156:8888');
        expect(Url.trimTrailingSlash('https://example.com')).toBe('https://example.com');
        expect(Url.trimTrailingSlash('/media/')).toBe('/media');
    });
});

describe("Env.requireUrl", () => {
    it("zwraca bazowy adres z .env bez końcowego ukośnika", () => {
        process.env.TEST_URL_WITH_SLASH = 'https://example.com/';
        expect(Env.requireUrl('TEST_URL_WITH_SLASH')).toBe('https://example.com');
        delete process.env.TEST_URL_WITH_SLASH;
    });
});
