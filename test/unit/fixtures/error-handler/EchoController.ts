import {Request, Response} from "express";
import {Controller, Post} from "../../../../src/decorators/WebServer";
import {AbstractController} from "../../../../src/controllers/AbstractController";

@Controller('/echo')
export class EchoController extends AbstractController {
    @Post('/')
    public async echo(request: Request, _response: Response): Promise<unknown> {
        return {received: request.body};
    }
}
