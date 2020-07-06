/* eslint-disable @typescript-eslint/no-explicit-any */

import * as AWSXRay from 'aws-xray-sdk';
import { Router } from 'express';
import { ValidateError } from 'tsoa';
import { loggingHandler, pydtLogger } from '../lib/logging';
import { ErrorResponse, HttpRequest, HttpResponse, HttpResponseError, LambdaProxyEvent } from './framework';
import { RegisterRoutes } from './_gen/routes/routes';

const router = Router();

router.get('/swagger.json', (req, res) => {
  // eslint-disable-next-line
  res.status(200).json(require('./_gen/swagger/swagger.json'));
});

type middlewareExec = (request: HttpRequest, response: HttpResponse, next: any) => void;

function methodHandler(method: string) {
  return function (route: string, ...routeExecs: middlewareExec[]) {
    router[method](route, (req: HttpRequest, res: HttpResponse) => {
      const mainSegment = AWSXRay.getSegment(); //returns the facade segment
      req.subSegment = mainSegment.addNewSubsegment(`${method} ${route}`);
      const ird = new AWSXRay.middleware.IncomingRequestData(req as any);
      ird.request.url = req.url;
      (req.subSegment as any).http = ird;

      const ns = AWSXRay.getNamespace();
      ns.run(function () {
        AWSXRay.setSegment(req.subSegment);
      });

      res.on('finish', () => {
        (req.subSegment as any).http.close(this);
        req.subSegment.close();
      });

      pydtLogger.info(`Found route ${route}`);

      const runNext = (runExecs: middlewareExec[]) => {
        const curExec: middlewareExec = runExecs[0];

        curExec(req, res, err => {
          if (err) {
            let status = 500;
            let message = 'There was an error processing your request.';
            let logError = true;

            if (err.constructor.name === 'InvalidRequestException') {
              // TODO: These probably shouldn't go to an end user, they come from TSOA and look like:
              // 'landingPageURL' is a required undefined parameter.
              status = err.status;
              message = err.message;
              logError = false;
            }

            if (err instanceof HttpResponseError) {
              status = err.statusCode;
              message = err.message;
              logError = false;
            }

            if (logError) {
              if (err instanceof ValidateError) {
                pydtLogger.error(`Validation Error on ${route}: ${JSON.stringify(err.fields, null, 2)}`, err);
              } else {
                pydtLogger.error(`Unhandled Exception from ${route}`, err);
              }
            }

            res.status(status).json(new ErrorResponse(message));
          } else if (runExecs.length > 1) {
            runNext(runExecs.slice(1));
          }
        });
      };

      runNext(routeExecs);
    });
  };
}

const mockApp: any = {
  delete: methodHandler('delete'),
  get: methodHandler('get'),
  patch: methodHandler('patch'),
  post: methodHandler('post'),
  put: methodHandler('put')
};

RegisterRoutes(mockApp);

export const handler = loggingHandler((event: LambdaProxyEvent) => {
  pydtLogger.info(`handling ${event.httpMethod} ${event.path} (${event.requestContext.identity.sourceIp})`);

  return new Promise((resolve, reject) => {
    const callback = (err, resp) => {
      if (err) {
        reject(err);
      } else {
        resolve(resp);
      }
    };

    const req = new HttpRequest(event);
    const resp = new HttpResponse(callback, req);

    if (event.httpMethod.toLowerCase() === 'options') {
      resp.status(200).end();
    } else {
      (router as any).handle(req, resp, err => {
        pydtLogger.error(`404 for ${event.httpMethod} ${event.path}`, err);
        resp.status(404).json(new ErrorResponse('Not Found'));
      });
    }
  });
});
