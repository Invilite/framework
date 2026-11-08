import {HelperOptions} from "handlebars";

export default class CanonicalUrl {

    public constructor() {
    }

    public getHelper(): (context: any, options?: HelperOptions) => string {
        return this.getCanonicalUrl.bind(this);
    }

    public getCanonicalUrl(context: any, options?: HelperOptions): string {
        const currentUrl: string = context?.data?.root?.currentUrl || '';
        if (!currentUrl) {
            return '';
        }

        let url: URL;
        try {
            url = new URL(currentUrl);
        } catch {
            return '';
        }

        return url.origin + url.pathname;
    }
}