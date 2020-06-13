import { GAMES } from 'pydt-shared-models';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Why is this flagging Query?
import { Get, Query, Request, Response, Route, Security, Tags } from 'tsoa';
import { Config } from '../../../lib/config';
import { GAME_REPOSITORY_SYMBOL, IGameRepository } from '../../../lib/dynamoose/gameRepository';
import { inject, provideSingleton } from '../../../lib/ioc';
import { IS3Provider, S3_PROVIDER_SYMBOL } from '../../../lib/s3Provider';
import { GameUtil } from '../../../lib/util/gameUtil';
import { ErrorResponse, HttpRequest, HttpResponseError } from '../../framework';
import { GameTurnResponse } from './_models';

@Route('game')
@Tags('game')
@provideSingleton(GameController_GetTurn)
export class GameController_GetTurn {
  constructor(
    @inject(GAME_REPOSITORY_SYMBOL) private gameRepository: IGameRepository,
    @inject(S3_PROVIDER_SYMBOL) private s3: IS3Provider
  ) {}

  @Security('api_key')
  @Response<ErrorResponse>(401, 'Unauthorized')
  @Get('{gameId}/turn')
  public async getTurn(@Request() request: HttpRequest, gameId: string, @Query() compressed = ''): Promise<GameTurnResponse> {
    const game = await this.gameRepository.getOrThrow404(gameId);

    if (game.currentPlayerSteamId !== request.user) {
      throw new HttpResponseError(400, `It's not your turn!`);
    }

    const file = GameUtil.createS3SaveKey(gameId, game.gameTurnRangeKey);

    const fileParams = {
      Bucket: Config.resourcePrefix + 'saves',
      Key: file
    };

    if (compressed) {
      fileParams.Key += '.gz';

      try {
        await this.s3.headObject(fileParams);
      } catch (err) {
        fileParams.Key = file;
      }
    }

    const civGame = GAMES.find(x => x.id === game.gameType);

    return {
      downloadUrl: this.s3.signedGetUrl(fileParams, '(PYDT) Play This One!.' + civGame.saveExtension, 60)
    };
  }
}
