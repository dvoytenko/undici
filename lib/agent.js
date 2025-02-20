'use strict'

const { InvalidArgumentError } = require('./core/errors')
const { kClients, kRunning, kClose, kDestroy, kDispatch, kInterceptors, kBusy } = require('./core/symbols')
const DispatcherBase = require('./dispatcher-base')
const Pool = require('./pool')
const Client = require('./client')
const util = require('./core/util')
const createRedirectInterceptor = require('./interceptor/redirectInterceptor')

const kOnConnect = Symbol('onConnect')
const kOnDisconnect = Symbol('onDisconnect')
const kOnConnectionError = Symbol('onConnectionError')
const kMaxRedirections = Symbol('maxRedirections')
const kOnDrain = Symbol('onDrain')
const kFactory = Symbol('factory')
const kOptions = Symbol('options')
const kDeleteScheduled = Symbol('deleteScheduled')

function defaultFactory (origin, opts) {
  return opts && opts.connections === 1
    ? new Client(origin, opts)
    : new Pool(origin, opts)
}

class Agent extends DispatcherBase {
  constructor ({ factory = defaultFactory, maxRedirections = 0, connect, ...options } = {}) {
    super()

    if (typeof factory !== 'function') {
      throw new InvalidArgumentError('factory must be a function.')
    }

    if (connect != null && typeof connect !== 'function' && typeof connect !== 'object') {
      throw new InvalidArgumentError('connect must be a function or an object')
    }

    if (!Number.isInteger(maxRedirections) || maxRedirections < 0) {
      throw new InvalidArgumentError('maxRedirections must be a positive number')
    }

    if (connect && typeof connect !== 'function') {
      connect = { ...connect }
    }

    this[kInterceptors] = options.interceptors && options.interceptors.Agent && Array.isArray(options.interceptors.Agent)
      ? options.interceptors.Agent
      : [createRedirectInterceptor({ maxRedirections })]

    this[kOptions] = { ...util.deepClone(options), connect }
    this[kOptions].interceptors = options.interceptors
      ? { ...options.interceptors }
      : undefined
    this[kMaxRedirections] = maxRedirections
    this[kFactory] = factory
    this[kClients] = new Map()

    const agent = this

    this[kOnDrain] = (origin, targets) => {
      agent.emit('drain', origin, [agent, ...targets])
    }

    this[kOnConnect] = (origin, targets) => {
      agent.emit('connect', origin, [agent, ...targets])
    }

    this[kOnDisconnect] = (origin, targets, err) => {
      agent.emit('disconnect', origin, [agent, ...targets], err)
    }

    this[kOnConnectionError] = (origin, targets, err) => {
      agent.emit('connectionError', origin, [agent, ...targets], err)
    }
  }

  get [kRunning] () {
    let ret = 0
    for (const client of this[kClients].values()) {
      ret += client[kRunning]
    }
    return ret
  }

  [kDispatch] (opts, handler) {
    let key
    if (opts.origin && (typeof opts.origin === 'string' || opts.origin instanceof URL)) {
      key = String(opts.origin)
    } else {
      throw new InvalidArgumentError('opts.origin must be a non-empty string or URL.')
    }

    let dispatcher = this[kClients].get(key)

    if (!dispatcher) {
      dispatcher = this[kFactory](opts.origin, this[kOptions])
        .on('drain', (...args) => {
          this[kOnDrain](...args)

          // We remove the client if it is not busy for 5 minutes
          // to avoid a long list of clients to saturate memory.
          // Ideally, we could use a FinalizationRegistry here, but
          // it is currently very buggy in Node.js.
          // See
          // * https://github.com/nodejs/node/issues/49344
          // * https://github.com/nodejs/node/issues/47748
          // TODO(mcollina): make the timeout configurable or
          // use an event to remove disconnected clients.
          this[kDeleteScheduled] = setTimeout(() => {
            if (dispatcher[kBusy] === 0) {
              this[kClients].destroy().then(() => {})
              this[kClients].delete(key)
            }
          }, 300_000)
          this[kDeleteScheduled].unref()
        })
        .on('connect', this[kOnConnect])
        .on('disconnect', this[kOnDisconnect])
        .on('connectionError', this[kOnConnectionError])

      this[kClients].set(key, dispatcher)
    } else if (dispatcher[kDeleteScheduled]) {
      clearTimeout(dispatcher[kDeleteScheduled])
      dispatcher[kDeleteScheduled] = null
    }

    return dispatcher.dispatch(opts, handler)
  }

  async [kClose] () {
    const closePromises = []
    for (const client of this[kClients].values()) {
      closePromises.push(client.close())
    }
    this[kClients].clear()

    await Promise.all(closePromises)
  }

  async [kDestroy] (err) {
    const destroyPromises = []
    for (const client of this[kClients].values()) {
      destroyPromises.push(client.destroy(err))
    }
    this[kClients].clear()

    await Promise.all(destroyPromises)
  }
}

module.exports = Agent
