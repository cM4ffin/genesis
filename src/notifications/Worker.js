'use strict';

const flatCache = require('flat-cache');
const Job = require('cron').CronJob;
require('colors');

const Notifier = require('./Notifier');
const FeedsNotifier = require('./FeedsNotifier');
const TwitchNotifier = require('./TwitchNotifier');

const WorldStateCache = require('../WorldStateCache');
const MessageManager = require('../settings/MessageManager');
const Rest = require('../tools/RESTWrapper');
const Database = require('../settings/Database');

const { logger, platforms } = require('./NotifierUtils');
const { emojify, games } = require('../CommonFunctions');
const cachedEvents = require('../resources/cachedEvents');

const activePlatforms = (process.env.PLATFORMS || 'pc').split(',');

const rest = new Rest();
const db = new Database();

const deps = {};

let timeout;

const forceHydrate = (process.argv[2] || '').includes('-hydrate');

logger.info(`forceHydrate: ${forceHydrate}`);

class Worker {
  constructor() {
    /**
     * Objects holding worldState data, one for each platform
     * @type {Object.<WorldStateCache>}
     */
    this.worldStates = {};

    timeout = process.env.WORLDSTATE_TIMEOUT || 60000;
    activePlatforms
      .forEach((platform) => {
        this.worldStates[platform] = new WorldStateCache(platform, timeout);
      });
  }

  /* eslint-disable-next-line class-methods-use-this */
  async hydrateGuilds() {
    const guilds = await db.getGuilds();
    if (guilds) {
      deps.workerCache.setKey('guilds', guilds);
      deps.workerCache.save(true);
    }
  }

  /* eslint-disable-next-line class-methods-use-this */
  async hydrateQueries() {
    for (const cachedEvent of cachedEvents) {
      for (const platform of activePlatforms) {
        deps.workerCache.setKey(`${cachedEvent}:${platform}`,
          await db.getAgnosticNotifications(cachedEvent, platform));
      }
    }
    deps.workerCache.save(true);
  }

  async initCache() {
    deps.workerCache = flatCache.load('worker',
      require('path').resolve('../../.cache'));

    const sDate = Date.now();
    // generate guild cache data if not present
    const currentGuilds = deps.workerCache.getKey('guilds');
    if (!currentGuilds || forceHydrate) await this.hydrateGuilds();

    let hydrateEvents = forceHydrate;
    for (const cachedEvent of cachedEvents) {
      for (const platform of activePlatforms) {
        if (!deps.workerCache.getKey(`${cachedEvent}:${platform}`)) {
          hydrateEvents = true;
        }
      }
    }
    if (hydrateEvents) await this.hydrateQueries();
    const eDate = Date.now();
    logger.info(`[${'DB'.brightMagenta}] hydration took ${String(eDate-sDate).red}ms`)

    // refresh guild cache every hour... it's a heavy process, we don't want to do it much
    deps.guildHydration = new Job('0 0 * * * *', this.hydrateGuilds.bind(this));
    deps.queryHydration = new Job('0 */10 * * * *', this.hydrateQueries.bind(this));
  }

  /**
   * Start the worker notifier systems
   * @returns {Promise} [description]
   */
  async start() {
    try {
      deps.settings = db;
      deps.client = rest;
      deps.worldStates = this.worldStates;
      deps.timeout = timeout;

      await rest.init();
      await deps.settings.init();
      await this.initCache();

      this.messageManager = new MessageManager(deps);
      deps.messageManager = this.messageManager;

      this.notifier = new Notifier(deps);

      if (games.includes("RSS")) {
        this.feedNotifier = new FeedsNotifier(deps);
        this.feedNotifier.start();
      }
      
      if (games.includes("TWITCH")) {
        this.twitchNotifier = new TwitchNotifier(deps);
        this.twitchNotifier.start();
      }

      await this.notifier.start();

      if (logger.isLoggable('debug')) {
        rest.controlMessage({
          embeds: [{
            description: `Worker ready on ${platforms}`,
            color: 0x2B90EC,
          }],
        });
      }
    } catch (e) {
      logger.error(e);
    }
  }
}

const worker = new Worker();

worker.start();
