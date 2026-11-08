import {HelperOptions} from "handlebars";

export default class CurrentUrl {

    public constructor() {
    }

    public getHelper(): (context: any, options?: HelperOptions) => void {
        return this.getCurrentUrl.bind(this);
    }

    public getCurrentUrl(context: any, options?: HelperOptions): string {
        return context?.data?.root?.currentUrl || '';
    }
}
