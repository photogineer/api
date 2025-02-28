import { difference } from 'lodash';
import { Post, Request, Response, Route, Security, Tags } from 'tsoa';
import * as zlib from 'zlib';
import { Config } from '../../../lib/config';
import { GAME_REPOSITORY_SYMBOL, IGameRepository } from '../../../lib/dynamoose/gameRepository';
import {
  GAME_TURN_REPOSITORY_SYMBOL,
  IGameTurnRepository
} from '../../../lib/dynamoose/gameTurnRepository';
import {
  IPrivateUserDataRepository,
  PRIVATE_USER_DATA_REPOSITORY_SYMBOL
} from '../../../lib/dynamoose/privateUserDataRepository';
import { IUserRepository, USER_REPOSITORY_SYMBOL } from '../../../lib/dynamoose/userRepository';
import { inject, provideSingleton } from '../../../lib/ioc';
import { pydtLogger } from '../../../lib/logging';
import { RANDOM_CIV } from '../../../lib/metadata/civGame';
import { CIV6_GAME } from '../../../lib/metadata/civGames/civ6';
import { PYDT_METADATA } from '../../../lib/metadata/metadata';
import { Game, GamePlayer } from '../../../lib/models';
import { IS3Provider, S3_PROVIDER_SYMBOL } from '../../../lib/s3Provider';
import { ActorType } from '../../../lib/saveHandlers/saveHandler';
import { GAME_TURN_SERVICE_SYMBOL, IGameTurnService } from '../../../lib/services/gameTurnService';
import { GameUtil } from '../../../lib/util/gameUtil';
import { ErrorResponse, HttpRequest, HttpResponseError } from '../../framework';
import { ISnsProvider, SNS_PROVIDER_SYMBOL } from '../../../lib/snsProvider';

@Route('game')
@Tags('game')
@provideSingleton(GameController_FinishSubmit)
export class GameController_FinishSubmit {
  constructor(
    @inject(GAME_REPOSITORY_SYMBOL) private gameRepository: IGameRepository,
    @inject(GAME_TURN_REPOSITORY_SYMBOL) private gameTurnRepository: IGameTurnRepository,
    @inject(USER_REPOSITORY_SYMBOL) private userRepository: IUserRepository,
    @inject(GAME_TURN_SERVICE_SYMBOL) private gameTurnService: IGameTurnService,
    @inject(S3_PROVIDER_SYMBOL) private s3: IS3Provider,
    @inject(PRIVATE_USER_DATA_REPOSITORY_SYMBOL) private pudRepository: IPrivateUserDataRepository,
    @inject(SNS_PROVIDER_SYMBOL) private sns: ISnsProvider
  ) {}

  @Security('api_key')
  @Response<ErrorResponse>(401, 'Unauthorized')
  @Post('{gameId}/turn/finishSubmit')
  public async finishSubmit(@Request() request: HttpRequest, gameId: string): Promise<Game> {
    const game = await this.gameRepository.getOrThrow404(gameId);

    if (game.currentPlayerSteamId !== request.user) {
      throw new HttpResponseError(400, `It's not your turn!`);
    }

    const gameTurn = await this.gameTurnRepository.get({
      gameId: game.gameId,
      turn: game.gameTurnRangeKey
    });
    game.gameTurnRangeKey++;

    const users = await this.userRepository.getUsersForGame(game);
    const user = users.find(u => {
      return u.steamId === request.user;
    });

    const data = await this.s3.getObject({
      Bucket: Config.resourcePrefix + 'saves',
      Key: GameUtil.createS3SaveKey(gameId, game.gameTurnRangeKey)
    });

    if (!data || !data.Body) {
      throw new Error("File doesn't exist?");
    }

    let buffer = data.Body;

    // Attempt to gunzip...
    try {
      buffer = zlib.unzipSync(data.Body as Buffer);
    } catch (e) {
      // If unzip fails, assume raw save file was uploaded...
      pydtLogger.info('unzip failed :(', e);
    }

    const saveHandler = this.gameTurnService.parseSaveFile(buffer, game);

    // Temporary code to upgrade Caesar games
    if (
      // If the game is in progress...
      game.gameTurnRangeKey > 1 &&
      // The game has Great Leaders...
      (game.dlc || []).includes('7A66DB58-B354-4061-8C80-95B638DD6F6C') &&
      // The game doesn't have Caesar...
      !(game.dlc || []).includes('9ED63236-617C-45A6-BB70-8CB6B0BE8ED2') &&
      // But it's showing up in the file...
      saveHandler.parsedDlcs.includes('9ED63236-617C-45A6-BB70-8CB6B0BE8ED2')
    ) {
      // Add it to the dlc
      game.dlc = [...(game.dlc || []), '9ED63236-617C-45A6-BB70-8CB6B0BE8ED2'];
    }

    const numCivs = saveHandler.civData.length;
    const parsedRound = saveHandler.gameTurn;
    const gameDlc = game.dlc || [];
    const civGame = PYDT_METADATA.civGames.find(x => x.id === game.gameType);

    const notInSave = difference(gameDlc, saveHandler.parsedDlcs);
    const notInGame = difference(saveHandler.parsedDlcs, gameDlc);

    if (notInSave.length || notInGame.length) {
      throw new HttpResponseError(
        400,
        `DLC mismatch!  Please ensure that you have the correct DLC enabled (or disabled)!${
          notInSave.length
            ? `
Enabled but not in save: ${notInSave
                .map(x => civGame.dlcs.find(y => y.id === x)?.displayName)
                .join(', ')}`
            : ''
        }${
          notInGame.length
            ? `
In save but not enabled: ${notInGame
                .map(x => civGame.dlcs.find(y => y.id === x)?.displayName)
                .join(', ')}`
            : ''
        }`
      );
    }

    if (numCivs !== game.slots) {
      throw new HttpResponseError(
        400,
        `Invalid number of civs in save file! (actual: ${numCivs}, expected: ${game.slots})`
      );
    }

    if (game.gameSpeed && game.gameSpeed !== saveHandler.gameSpeed) {
      throw new HttpResponseError(
        400,
        `Invalid game speed in save file!  (actual: ${saveHandler.gameSpeed}, expected: ${game.gameSpeed})`
      );
    }

    if (game.mapFile) {
      const map = civGame.maps.find(x => x.file === game.mapFile);
      const saveMap = saveHandler.mapFile || '';

      if (map && map.regex) {
        if (!new RegExp(map.regex).test(saveMap)) {
          throw new HttpResponseError(
            400,
            `Invalid map file in save file! (actual: ${saveMap}, expected regex: ${map.regex})`
          );
        }
      } else if (saveMap.toLowerCase().indexOf(game.mapFile.toLowerCase()) < 0) {
        throw new HttpResponseError(
          400,
          `Invalid map file in save file! (actual: ${saveMap}, expected: ${game.mapFile})`
        );
      }
    }

    if (game.mapSize && game.mapSize !== saveHandler.mapSize) {
      throw new HttpResponseError(
        400,
        `Invalid map size in save file! (actual: ${saveHandler.mapSize}, expected: ${game.mapSize})`
      );
    }

    const newDefeatedPlayers = [];

    for (let i = 0; i < saveHandler.civData.length; i++) {
      const civ = saveHandler.civData[i];

      if (game.players[i]) {
        const actualCiv = civ.leaderName;
        const expectedCiv = game.players[i].civType;

        if (!expectedCiv || expectedCiv === RANDOM_CIV.leaderKey) {
          game.players[i].civType = actualCiv;
        } else if (actualCiv !== expectedCiv) {
          throw new HttpResponseError(
            400,
            `Incorrect civ type in save file! (actual: ${actualCiv}, expected: ${expectedCiv})`
          );
        }

        if (GameUtil.playerIsHuman(game.players[i])) {
          if (civ.type === ActorType.DEAD) {
            // Player has been defeated!
            game.players[i].hasSurrendered = true;
            game.players[i].surrenderDate = new Date();
            newDefeatedPlayers.push(game.players[i]);
          } else if (civ.type === ActorType.AI) {
            // This is OK, type will be reset in updateSaveFileForGameState, and may be wrong
            // because of skipped turns!
            // throw new HttpResponseError(400, `Expected civ ${i + 1} to be human!`);
          }
        } else {
          if (civ.type === ActorType.HUMAN) {
            // I'm not sure that we care about this, either, should be set properly in updateSaveFileForGameState
            // throw new HttpResponseError(400, `Expected civ ${i + 1} to be AI/Dead!`);
          }
        }
      } else {
        if (civ.type === ActorType.HUMAN) {
          throw new HttpResponseError(400, `Expected civ ${i + 1} to be AI/Dead!`);
        }

        game.players[i] = {
          civType: civ.leaderName
        } as GamePlayer;
      }
    }

    let expectedRound = gameTurn.round;
    let nextPlayerIndex = GameUtil.getNextPlayerIndex(game);

    if (gameTurn.turn === 1 || game.resetGameStateOnNextUpload) {
      // When starting a game, take whatever round is in the file.  This allows starting in different eras.
      expectedRound = parsedRound;

      // Also take whatever player is active in the file.  This helps with migrating games from PBC/online.
      nextPlayerIndex = saveHandler.civData.findIndex(x => x.isCurrentTurn);

      game.resetGameStateOnNextUpload = false;

      if (nextPlayerIndex === -1) {
        throw new HttpResponseError(
          400,
          `Couldn't detect the current player in the save file.  If you're converting this game from PBC or Online multiplayer, you may need to play a turn in Hotseat mode to get the file converted properly.`
        );
      }
    } else if (nextPlayerIndex <= GameUtil.getCurrentPlayerIndex(game)) {
      // Allow round to stay the same on the turn for civ 6 world congress...
      if (!(game.gameType === CIV6_GAME.id && parsedRound === gameTurn.round)) {
        expectedRound++;
      }
    }

    if (!saveHandler.civData[nextPlayerIndex].isCurrentTurn) {
      throw new HttpResponseError(
        400,
        `Incorrect player turn in save file!  This probably means it is still your turn and you have some more moves to make!`
      );
    }

    if (expectedRound !== parsedRound) {
      throw new HttpResponseError(
        400,
        `Incorrect game turn in save file! (actual: ${parsedRound}, expected: ${expectedRound})`
      );
    }

    game.currentPlayerSteamId = game.players[nextPlayerIndex].steamId;
    game.round = expectedRound;
    game.completed = GameUtil.calculateIsCompleted(game);
    const sendFinalizedMessage = game.completed && !game.finalized;
    game.finalized = game.completed;

    GameUtil.possiblyUpdateAdmin(game);

    await this.gameTurnService.updateSaveFileForGameState(game, users, saveHandler);
    await this.gameTurnService.moveToNextTurn(game, gameTurn, user);

    if (newDefeatedPlayers.length) {
      await this.gameTurnService.defeatPlayers(game, users, newDefeatedPlayers);
    }

    if (sendFinalizedMessage) {
      await this.sns.gameFinalized(game);
    }

    const pud = await this.pudRepository.get(request.user);
    pud.lastTurnIpAddress = request.sourceIp;
    await this.pudRepository.saveVersioned(pud);

    return game;
  }
}
