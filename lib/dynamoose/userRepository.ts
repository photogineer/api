import { Config } from '../config';
import { provideSingleton } from '../ioc';
import { User } from '../models/user';
import { BaseDynamooseRepository, IRepository } from './common';
import { Game } from '../models';

export const USER_REPOSITORY_SYMBOL = Symbol('IUserRepository');

export interface IUserRepository extends IRepository<string, User> {
  allUsers(): Promise<User[]>;
  usersWithTurnsPlayed(): Promise<User[]>;
  substituteUsers(): Promise<User[]>;
  getUsersForGame(game: Game): Promise<User[]>;
}

@provideSingleton(USER_REPOSITORY_SYMBOL)
export class UserRepository extends BaseDynamooseRepository<string, User> implements IUserRepository {
  constructor() {
    super(Config.resourcePrefix + 'user', {
      steamId: {
        type: String,
        hashKey: true
      },
      displayName: {
        type: String,
        required: true
      },
      avatarSmall: String,
      avatarMedium: String,
      avatarFull: String,
      steamProfileUrl: String,
      emailAddress: String,
      activeGameIds: [String],
      inactiveGameIds: [String],
      vacationMode: Boolean,
      timezone: String,
      comments: String,
      lastTurnEndDate: Date,
      webhookUrl: String,
      forumUsername: String,
      turnsPlayed: {
        type: Number,
        default: 0
      },
      turnsSkipped: {
        type: Number,
        default: 0
      },
      timeTaken: {
        type: Number,
        default: 0
      },
      fastTurns: {
        type: Number,
        default: 0
      },
      slowTurns: {
        type: Number,
        default: 0
      },
      statsByGameType: [
        {
          gameType: String,
          lastTurnEndDate: Date,
          activeGames: {
            type: Number,
            default: 0
          },
          totalGames: {
            type: Number,
            default: 0
          },
          turnsPlayed: {
            type: Number,
            default: 0
          },
          turnsSkipped: {
            type: Number,
            default: 0
          },
          timeTaken: {
            type: Number,
            default: 0
          },
          fastTurns: {
            type: Number,
            default: 0
          },
          slowTurns: {
            type: Number,
            default: 0
          }
        }
      ],
      willSubstituteForGameTypes: [String],
      dataVersion: Number,
      banned: Boolean
    });
  }

  allUsers() {
    return this.scanAllUsers(false, () => {
      return this.scan();
    });
  }

  usersWithTurnsPlayed() {
    return this.scanAllUsers(true, () => {
      return this.scan().where('turnsPlayed').gt(0);
    });
  }

  substituteUsers() {
    return this.scanAllUsers(true, () => {
      return this.scan().where('willSubstituteForGameTypes').not().null();
    });
  }

  public getUsersForGame(game: Game): Promise<User[]> {
    const steamIds = game.players.map(x => x.steamId).filter(Boolean);
    return this.batchGet(steamIds).then(users => {
      // make sure they're sorted correctly...
      const playersWithSteamIds = game.players.filter(player => {
        return !!player.steamId;
      });

      return playersWithSteamIds.map(player => {
        return users.find(user => {
          return user.steamId === player.steamId;
        });
      });
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async scanAllUsers(removeEmail: boolean, createScanQuery: () => any) {
    const result: User[] = [];
    let lastKey;

    do {
      let scan = createScanQuery();

      if (lastKey) {
        scan = scan.startAt(lastKey);
      }

      const users: User[] = await scan.exec();

      for (const user of users) {
        if (removeEmail) {
          delete user.emailAddress; // make sure email address isn't returned!
        }

        result.push(user);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lastKey = (users as any).lastKey;
    } while (lastKey);

    return result;
  }
}
