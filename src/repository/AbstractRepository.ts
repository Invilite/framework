import AbstractModel from "../models/AbstractModel";
import {WithId} from "../types";

export default abstract class AbstractRepository<Model extends AbstractModel> {

    protected constructor(private readonly modelClass: new () => Model) {}

    protected getModelInstance(data: any, insertedId: string | number): WithId<Model> {
        const model: Model = new this.modelClass();
        model.hydrateModel(data, insertedId);

        return model as WithId<Model>;
    }
}
