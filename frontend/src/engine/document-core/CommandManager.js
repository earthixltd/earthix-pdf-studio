import { PdfEngineError } from '../engineErrors.js'

let nextStateSequence = 0

function createStateId() {
  nextStateSequence += 1
  return `earthix-state-${nextStateSequence}`
}

function validateCommand(command, message = 'A document command must implement execute() and undo().') {
  if (!command || typeof command.execute !== 'function' || typeof command.undo !== 'function') {
    throw new PdfEngineError(message, { code: 'INVALID_DOCUMENT_COMMAND' })
  }
}

async function rollbackCommands(commands, context) {
  const errors = []
  for (const command of [...commands].reverse()) {
    try {
      await command.undo(context)
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

class CompositeCommand {
  constructor(label, commands) {
    this.label = label
    this.commands = [...commands]
    this.createdAt = new Date().toISOString()
  }

  async execute(context) {
    const attempted = []
    try {
      for (const command of this.commands) {
        attempted.push(command)
        await command.execute(context)
      }
    } catch (error) {
      const rollbackErrors = await rollbackCommands(attempted, context)
      if (rollbackErrors.length) {
        throw new AggregateError([error, ...rollbackErrors], 'Redo failed and the composite command could not be fully rolled back.')
      }
      throw error
    }
  }

  async undo(context) {
    const attempted = []
    try {
      for (const command of [...this.commands].reverse()) {
        attempted.push(command)
        await command.undo(context)
      }
    } catch (error) {
      const restoreErrors = []
      for (const command of [...attempted].reverse()) {
        try {
          await command.execute(context)
        } catch (restoreError) {
          restoreErrors.push(restoreError)
        }
      }
      if (restoreErrors.length) {
        throw new AggregateError([error, ...restoreErrors], 'Undo failed and the composite command could not be restored.')
      }
      throw error
    }
  }
}

export class CommandManager {
  #context
  #history = []
  #cursor = 0
  #cursorStateId = 'earthix-state-root'
  #listeners = new Set()
  #busy = false
  #transactionActive = false

  constructor(context) {
    this.#context = context
  }

  get canUndo() { return this.#cursor > 0 }
  get canRedo() { return this.#cursor < this.#history.length }
  get historyIndex() { return this.#cursor }
  get historyLength() { return this.#history.length }
  get currentStateId() { return this.#cursorStateId }

  getHistory() {
    return this.#history.map((entry, index) => ({
      id: entry.id,
      label: entry.label,
      createdAt: entry.createdAt,
      status: index < this.#cursor ? 'applied' : 'undone',
      isCurrent: index === this.#cursor - 1,
      beforeStateId: entry.beforeStateId,
      afterStateId: entry.afterStateId,
    }))
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('A command listener must be a function.')
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(action) {
    const state = {
      action,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      historyIndex: this.#cursor,
      historyLength: this.#history.length,
      currentStateId: this.#cursorStateId,
      history: this.getHistory(),
    }
    for (const listener of this.#listeners) {
      try {
        listener(state)
      } catch (error) {
        this.#context?.onCommandListenerError?.(error)
      }
    }
  }

  #assertIdle() {
    if (this.#busy || this.#transactionActive) {
      throw new PdfEngineError('Another document command is still running.', { code: 'DOCUMENT_COMMAND_BUSY' })
    }
  }

  #beginAtomicChange() {
    this.#context.beginAtomicChange?.()
  }

  #endAtomicChange(commit) {
    this.#context.endAtomicChange?.({ commit })
  }

  #record(command, action) {
    this.#history.splice(this.#cursor)
    const entry = {
      id: createStateId(),
      label: command.label || 'Document change',
      createdAt: command.createdAt || new Date().toISOString(),
      command,
      beforeStateId: this.#cursorStateId,
      afterStateId: createStateId(),
    }
    this.#history.push(entry)
    this.#cursor += 1
    this.#cursorStateId = entry.afterStateId
    this.#emit(action)
  }

  async execute(command) {
    this.#assertIdle()
    validateCommand(command)
    this.#busy = true
    this.#beginAtomicChange()
    let commit = false
    try {
      try {
        await command.execute(this.#context)
      } catch (error) {
        try {
          await command.undo(this.#context)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Document command failed and its partial changes could not be rolled back.')
        }
        throw error
      }
      this.#record(command, 'execute')
      commit = true
      return true
    } finally {
      this.#busy = false
      this.#endAtomicChange(commit)
    }
  }

  async undo() {
    this.#assertIdle()
    if (!this.canUndo) return false
    this.#busy = true
    this.#beginAtomicChange()
    let commit = false
    try {
      const entry = this.#history[this.#cursor - 1]
      try {
        await entry.command.undo(this.#context)
      } catch (error) {
        try {
          await entry.command.execute(this.#context)
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], 'Undo failed and the document could not be restored to its prior state.')
        }
        throw error
      }
      this.#cursor -= 1
      this.#cursorStateId = entry.beforeStateId
      this.#emit('undo')
      commit = true
      return true
    } finally {
      this.#busy = false
      this.#endAtomicChange(commit)
    }
  }

  async redo() {
    this.#assertIdle()
    if (!this.canRedo) return false
    this.#busy = true
    this.#beginAtomicChange()
    let commit = false
    try {
      const entry = this.#history[this.#cursor]
      try {
        await entry.command.execute(this.#context)
      } catch (error) {
        try {
          await entry.command.undo(this.#context)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Redo failed and its partial changes could not be rolled back.')
        }
        throw error
      }
      this.#cursor += 1
      this.#cursorStateId = entry.afterStateId
      this.#emit('redo')
      commit = true
      return true
    } finally {
      this.#busy = false
      this.#endAtomicChange(commit)
    }
  }

  async transact(label, callback) {
    this.#assertIdle()
    if (typeof callback !== 'function') throw new TypeError('A transaction requires a callback.')
    this.#busy = true
    this.#transactionActive = true
    this.#beginAtomicChange()
    const attempted = []
    let commit = false
    const transaction = {
      execute: async (command) => {
        validateCommand(command, 'A transaction command must implement execute() and undo().')
        attempted.push(command)
        await command.execute(this.#context)
      },
      get length() { return attempted.length },
    }

    try {
      const result = await callback(transaction)
      if (attempted.length) this.#record(new CompositeCommand(label || 'Document transaction', attempted), 'transaction')
      commit = true
      return result
    } catch (error) {
      const rollbackErrors = await rollbackCommands(attempted, this.#context)
      if (rollbackErrors.length) {
        throw new AggregateError([error, ...rollbackErrors], 'Document transaction failed and one or more rollback operations also failed.')
      }
      throw error
    } finally {
      this.#transactionActive = false
      this.#busy = false
      this.#endAtomicChange(commit)
    }
  }
}
