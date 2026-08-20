/**
 * `bridge` plugin: the chat bridge between the pet and one harness runtime.
 * Wraps the Electron-free {@link DesktopPetBridge} core, publishes the `pet`
 * service, and re-emits snapshot changes as host `snapshot` events so the
 * window plugin (or any external plugin) can render them. It also surfaces
 * raw wire signals the state machine ignores: `turn:done` when a prompt
 * settles with a reply, and `approval:asked` when the runtime requests user
 * approval.
 *
 * @module desktop-pet/plugins/bridge
 */

import { DesktopPetBridge } from '../core/bridge.ts'
import { definePlugin, EVENTS, SERVICES, type PetLogger, type PetService, type PetTodoService } from '../core/plugin.ts'
import { object, string, type Schema } from '../core/schema.ts'
import type { PetHarness } from '../types.ts'

/** Options for the `bridge` plugin. */
export interface BridgePluginOptions {
  /** Stable session id; every pet chat shares one conversation (default `desktop-pet`). */
  sessionId?: string | undefined
}

/** Options schema for the `bridge` plugin. */
export const bridgeConfig: Schema<BridgePluginOptions> = object({
  sessionId: string('desktop-pet'),
})

/** Shared guard: questions and recall queries never become todos. */
const TODO_QUESTION_HINT = /[？?]|吗|呢|嘛|什么|怎么|为什么|是不是|能不能|可不可以|行不行|有没有|哪些/

/** Shared guard: requests addressed to the pet never become todos. */
const TODO_PET_REQUEST_HINT = /^(?:帮我|请帮我|麻烦你|你能|你可以|给我|请你)/

/** Todo-topic vocabulary. Mentioning any of these marks a message as a
 * record/plan statement even when it starts with a pet-request prefix:
 * "帮我记录一下下面几个待办…" IS a todo list, while "帮我查天气" is not. */
const TODO_TOPIC_HINT = /(?:待办|代办|任务|事项|清单|记录|记一下|记个|添加)/

/** Numbered list markers: "1、" "2." "3）" "①" "一、" … A marker right after
 * todo vocabulary ("待办1、…") or a colon is still recognized, so the first
 * item of "下面几个代办1、token消耗 2、…" is not lost. */
const NUMBERED_ITEM_RE = /(?:^|[\s\u3000，,。；;：:]|(?:待办|代办|任务|事项|下面|以下|如下|几个|的|是|有))([0-9０-９]{1,3}|[一二三四五六七八九十]{1,3}|[①②③④⑤⑥⑦⑧⑨⑩]+)[、.．)）]/g

/** A 待办-led phrase: "待办如下/以下/下面/是/：" or the reversed
 * "下面/以下/这…待办" ("下面几个代办：买菜、拖地、倒垃圾"). */
const TODO_BULK_PHRASE_RE = /(?:待办|代办|任务|事项)\s*(?:如下|以下|下面|是|有|：|:)|(?:下面|以下|如下|这|那)(?:几个|些|些个|个)?(?:待办|代办|任务|事项)/

/**
 * Rule-based todo heuristic: turns casual plans/reminders ("我明天要交周报",
 * "别忘了买牛奶", "该写周报了") into a todo without an explicit command.
 *
 * Deliberately permissive — a false positive (a chatty sentence recorded) is
 * preferred over missing a real plan, and `todo.add` deduplicates against
 * open items with the same text. Never fires on:
 * - questions (什么/吗/怎么/能不能 …) — "你记得什么" is a recall command;
 * - requests addressed to the pet (帮我/你能/麻烦你 …) — those ask the pet
 *   to do something, not the user;
 * - recollection ("我记得…" = remembering the past, not a plan);
 * - bulk lists (≥ 2 numbered items, or a 待办-led comma list) — those go
 *   through {@link detectBulkTodoList} + LLM extraction instead.
 *
 * @param text - the trimmed user message.
 * @returns the extracted todo text, or null when nothing should be recorded.
 */
export function extractTodoHeuristic(text: string): string | null {
  const t = text.trim()
  if (t === '') return null
  if (TODO_QUESTION_HINT.test(t)) return null
  // "帮我查天气" is a pet request; "帮我记录一下…待办" is a todo statement.
  if (TODO_PET_REQUEST_HINT.test(t) && !TODO_TOPIC_HINT.test(t)) return null
  if (detectBulkTodoList(t)) return null
  const rules: RegExp[] = [
    // Reminder phrasing: "别忘了X" / "记得X" / "要记得X"（"我记得…"是回忆，排除）。
    // Lookbehind blocks 记得 right after 我, so "我记得你上次说…" is never a todo.
    /(?<!我)(?:别忘了|别忘记|不要忘了|要记得|记得|记住要)(?:[:：])?\s*([^，。！？、\n]{2,40})/,
    // Future-plan phrasing: "我明天要交周报" / "明天得去银行" / "该写周报了"。
    // The action verb is part of the captured todo text ("交周报" not "周报"),
    // and the verb list keeps the rule from firing on non-plan sentences.
    /(?:我|咱们|我们)?(?:今天|明天|后天|今晚|下周|下个星期|下个月|周末|下周末|周[一二三四五六日天]|星期[一二三四五六日天]|[0-9]+(?::|点)[0-9]*|上午|中午|下午|晚上|早上)?(?:要|得|需要|必须|打算|计划|准备|该)((?:去|做|写|买|交|发|见|联系|给|打|开|关|洗|收拾|整理|准备|完成|处理|回|约|取|送|参加|学|看|听|吃|喝|读|签|修|改|换|办|申请|提交|上传|下载|寄|收|接)[^，。！？、\n]{1,39})/,
  ]
  for (const rule of rules) {
    const match = rule.exec(t)
    if (match === null) continue
    const candidate = match[1]!.trim().replace(/[了罢吧呀啊哦哈呢]+$/, '')
    if (candidate.length >= 2 && candidate.length <= 40) return candidate
  }
  return null
}

/**
 * Detect a BULK todo list — a message listing several todos at once, which a
 * single-item heuristic cannot handle ("别忘了 下面五个待办 1、token消耗
 * 2、生图、米塔api …" or "待办：买菜、拖地、倒垃圾"). Such messages are
 * routed to the model for extraction instead of the local heuristic.
 *
 * @param text - the trimmed user message.
 * @returns true when the message should go through bulk LLM extraction.
 */
export function detectBulkTodoList(text: string): boolean {
  const t = text.trim()
  if (t === '') return false
  if (TODO_QUESTION_HINT.test(t)) return false
  // "帮我查天气" is a pet request; "帮我记录一下…待办" is a todo statement.
  if (TODO_PET_REQUEST_HINT.test(t) && !TODO_TOPIC_HINT.test(t)) return false
  // ≥ 2 numbered items is almost certainly a list of things to track.
  const numbered = (t.match(NUMBERED_ITEM_RE) ?? []).length
  if (numbered >= 2) return true
  // A 待办-led phrase followed by ≥ 2 comma-separated items.
  if (TODO_BULK_PHRASE_RE.test(t)) {
    const rest = t.replace(TODO_BULK_PHRASE_RE, '').replace(/^[\s：:、，,；;]+/, '').trim()
    const items = rest.split(/[、，,；;]/).map(item => item.trim()).filter(item => item.length >= 2)
    if (items.length >= 2) return true
  }
  return false
}

/**
 * Extract the individual todos from a bulk list message via a separate model
 * session (mirrors the memory consolidation path). The model is asked for one
 * todo per line; the reply is parsed into clean texts.
 *
 * @returns the extracted todo texts, or null when the model found none.
 */
async function extractBulkTodos(
  harness: PetHarness,
  sessionId: string,
  text: string,
  logger: PetLogger,
): Promise<string[] | null> {
  const prompt = [
    '请把下面这段文字里的待办事项逐条提取出来。',
    '要求：',
    '1. 每行一条，只输出待办本身；',
    '2. 去掉编号、序号，以及「待办/任务/别忘了/记得」等引导词；',
    '3. 保留时间、对象等有用信息，措辞尽量贴近原文；',
    '4. 不要增删用户没提到的内容；',
    '5. 如果里面没有待办，只输出「无」。',
    '',
    '[原文]',
    text,
  ].join('\n')
  const result = await harness.session(`${sessionId}-todos`).run(prompt)
  const lines = result.finalResponse.split(/\r?\n/)
    .map(line => line.trim().replace(/^[\s\d、.．)）\-*•·]+/, ''))
    .filter(line => line !== '' && line !== '无')
  if (lines.length === 0) {
    logger.warn('todo bulk extraction returned no items (model replied: %s)', result.finalResponse.trim())
    return null
  }
  return lines
}

/** Extract `{ id, toolName }` from an `approval/asked` session event, or null when malformed. */
function approvalPayload(event: unknown): { id: unknown; toolName: unknown } | null {
  if (typeof event !== 'object' || event === null) return null
  const record = event as Record<string, unknown>
  const data = typeof record.data === 'object' && record.data !== null ? record.data as Record<string, unknown> : {}
  return { id: data['id'], toolName: data['toolName'] }
}

/**
 * The `bridge` plugin. Requires the `runtime` plugin (for the `harness`
 * service). Teardown closes the bridge, which settles the queued prompt and
 * reaps the runtime through the harness.
 */
export const bridgePlugin = definePlugin<BridgePluginOptions>({
  name: 'bridge',
  version: '0.1.0',
  description: 'Serializes chat prompts onto one session and folds notifications into snapshots',
  requires: ['runtime'],
  config: bridgeConfig,
  setup(ctx, options) {
    const harness = ctx.getOrThrow<PetHarness>('harness')
    const bridge = new DesktopPetBridge(harness, {
      ...options.sessionId !== undefined && { sessionId: options.sessionId },
      onNotification: (notification) => {
        const event = notification.params.event
        if (typeof event === 'object' && event !== null && (event as Record<string, unknown>).type === 'approval/asked') {
          const payload = approvalPayload(event)
          ctx.emit(EVENTS.approvalAsked, payload ?? { id: undefined, toolName: undefined })
        }
      },
    })
    const disposeListen = bridge.listen((snapshot) => ctx.emit(EVENTS.snapshot, snapshot))
    // On the first prompt of each launch, inject the pet's identity, persona,
    // and long-term memory so the conversation starts from a remembered self.
    let memorySent = false
    let consolidating = false

    /** Distill overflowing working history into an episode via a separate session. */
    const maybeConsolidate = async (): Promise<void> => {
      const memory = ctx.get<import('../core/plugin.ts').PetMemoryService>(SERVICES.memory)
      if (memory === undefined || consolidating) return
      const overflow = memory.overflowCount()
      if (overflow <= 0) return
      consolidating = true
      try {
        const drained = memory.drainHistory(overflow)
        const transcript = drained.map(e => `${e.role === 'user' ? '用户' : '你'}：${e.text}`).join('\n')
        const prompt = [
          '请把下面这段对话整理成长期记忆要点。只输出要点本身，每行一条，',
          '用第三人称（「用户」/「宠物」）简洁记录用户透露的信息、偏好、约定和重要事件；',
          '省略寒暄与无关细节。若没有值得长期记住的内容，只输出「无」。',
          '',
          '[对话]',
          transcript,
        ].join('\n')
        const result = await harness.session(`${options.sessionId ?? 'desktop-pet'}-memory`).run(prompt)
        memory.addEpisode(result.finalResponse)
      } catch (error) {
        ctx.logger.warn('memory consolidation failed: %s', error instanceof Error ? error.message : String(error))
      } finally {
        consolidating = false
      }
    }

    const service: PetService = {
      prompt: async (text) => {
        const memory = ctx.get<import('../core/plugin.ts').PetMemoryService>(SERVICES.memory)
        const todo = ctx.get<PetTodoService>(SERVICES.todo)
        const trimmed = text.trim()

        // --- Memory commands (handled in-band; the message still reaches the model).
        let memoryCommand = false
        if (memory !== undefined) {
          // "记住：X" / "请记住：X" / "帮我记住：X" / "别忘了：X"
          const taught = /^(?:请|帮我)?(?:记住|别忘了)[:：]\s*(.+)$/.exec(trimmed)
          if (taught !== null) {
            memoryCommand = true
            memory.addFact(taught[1]!, 'command')
          }
          // "忘了：X" / "忘记：X"
          const forgotten = /^(?:请|帮我)?(?:忘了|忘记)[:：]\s*(.+)$/.exec(trimmed)
          if (forgotten !== null) {
            memoryCommand = true
            memory.removeFact(forgotten[1]!)
          }
        }
        // "你记得什么" → force-inject the current facts/episodes so the model can recite.
        const recalling = /你(?:都)?记得(?:什么|哪些|哪些事)|你的记忆|你记住了什么/.test(trimmed)

        // "查看待办" → force-inject the current list so the model can recite it.
        const todoViewing = todo !== undefined && (
          /^(?:查看|看看|列出|展示|报一下|念一下)(?:我的|当前|所有)?(?:待办|代办|任务|事项)(?:列表)?$/.test(trimmed) ||
          /^(?:我的)?(?:待办|代办|任务|事项)(?:列表)?$/.test(trimmed) ||
          /^(?:有|还有|现在有)(?:什么|哪些)(?:待办|代办|任务|事项)/.test(trimmed) ||
          /^(?:几个|多少)(?:待办|代办|任务|事项)/.test(trimmed)
        )

        // --- Bulk todo list ("别忘了 下面五个待办 1、x 2、y …"): one message
        // carries several todos, so it is routed to model extraction instead
        // of the single-item heuristic.
        const bulkList = todo !== undefined && todo.autoRecord && !memoryCommand && !todoViewing && detectBulkTodoList(trimmed)

        // --- Todo commands (handled in-band; the message still reaches the model).
        // The side effects never throw into the prompt: a malformed command
        // simply falls through to the model, which answers naturally.
        let explicitTodoCommand = false
        if (todo !== undefined) {
          // "记个待办：X" / "记录待办：X" / "添加待办：X" / "加个待办：X" / "新建待办：X"
          const added = /^(?:帮我|给我)?(?:记(?:个|录|一下|一记|录一下)?|添加|加个|新建|新增|写下|安排)(?:一个)?(?:待办|代办|任务|事项)[:：]\s*(.+)$/.exec(trimmed)
          // A bulk list wins over the single-item add ("记个待办：1、x 2、y").
          if (added !== null && !bulkList) {
            explicitTodoCommand = true
            try { todo.add(added[1]!) } catch (error) { ctx.logger.warn('todo add failed: %s', error instanceof Error ? error.message : String(error)) }
          }
          // "完成待办：X" / "搞定待办：X" / "划掉待办：X"
          const completed = /^(?:帮我|给我)?(?:完成|搞定|做完|划掉|勾掉)(?:了|掉)?(?:这个|这条)?(?:待办|代办|任务|事项)[:：]?\s*(.+)$/.exec(trimmed)
          if (completed !== null) {
            explicitTodoCommand = true
            todo.complete(completed[1]!)
          }
          // "取消完成待办：X" / "恢复待办：X" / "重新打开待办：X"
          const uncompleted = /^(?:帮我|给我)?(?:取消完成|撤销完成|恢复|重新打开)(?:这个|这条)?(?:待办|代办|任务|事项)[:：]?\s*(.+)$/.exec(trimmed)
          if (uncompleted !== null) {
            explicitTodoCommand = true
            todo.uncomplete(uncompleted[1]!)
          }
          // "删除待办：X" / "移除待办：X" / "删掉待办：X"
          const removed = /^(?:帮我|给我)?(?:删除|移除|删掉|去掉)(?:这个|这条)?(?:待办|代办|任务|事项)[:：]?\s*(.+)$/.exec(trimmed)
          if (removed !== null) {
            explicitTodoCommand = true
            todo.remove(removed[1]!)
          }
          // "清空待办" / "清除所有待办"
          if (/^(?:帮我|给我)?(?:清空|清除|全部删除)(?:所有)?(?:待办|代办|任务|事项)/.test(trimmed)) {
            explicitTodoCommand = true
            todo.clear()
          }
        }

        // --- Heuristic auto-record: casual plans/reminders become todos
        // without an explicit command (only when `todo.autoRecord` is on).
        let autoTodo: string | null = null
        if (todo !== undefined && todo.autoRecord && !explicitTodoCommand && !memoryCommand && !todoViewing && !bulkList) {
          autoTodo = extractTodoHeuristic(trimmed)
          if (autoTodo !== null) {
            try { todo.add(autoTodo) } catch (error) {
              ctx.logger.warn('todo auto-record failed: %s', error instanceof Error ? error.message : String(error))
              autoTodo = null
            }
          }
        }

        // --- Bulk extraction: pull each item out of a list message via a
        // separate model session (awaited before the main reply so the pet
        // can confirm the count). Dedup happens inside todo.add.
        let bulkTodoItems: string[] | null = null
        if (bulkList) {
          try {
            bulkTodoItems = await extractBulkTodos(harness, options.sessionId ?? 'desktop-pet', trimmed, ctx.logger)
          } catch (error) {
            ctx.logger.warn('todo bulk extraction failed: %s', error instanceof Error ? error.message : String(error))
            bulkTodoItems = null
          }
          if (bulkTodoItems !== null) {
            for (const item of bulkTodoItems) {
              try { todo.add(item) } catch (error) {
                ctx.logger.warn('todo add failed: %s', error instanceof Error ? error.message : String(error))
              }
            }
          }
        }

        let input = text
        if (!memorySent || recalling || todoViewing) {
          const firstTime = !memorySent
          if (!recalling) memorySent = true
          const identity = ctx.get<import('../core/plugin.ts').PetIdentityService>(SERVICES.identity)?.name
          const parts: string[] = []
          if (firstTime && !recalling && identity !== undefined && identity !== '' && identity !== '桌宠') {
            parts.push(`你的名字叫「${identity}」，用户会这样称呼你。`)
          }
          if (memory !== undefined) {
            if (recalling) {
              const recall = memory.recallText()
              parts.push(recall === '' ? '你还没有任何长期记忆。' : `[你目前记得的]：\n${recall}`)
            } else if (firstTime) {
              const context = memory.context()
              if (context !== '') parts.push(context)
            }
          }
          if (todo !== undefined && todoViewing) {
            const list = todo.listText()
            parts.push(list === '' ? '主人目前没有任何待办。' : `[主人目前的待办清单，请据此回答]：\n${list}`)
          }
          if (parts.length > 0) {
            input = `[系统设定与长期记忆，请自然地活出来，不要复述。]\n${parts.join('\n\n')}\n\n[用户现在说：]\n${text}`
          }
        }
        // When the heuristic recorded a todo, tell the model so it can
        // confirm naturally instead of guessing.
        if (autoTodo !== null) {
          input = `${input}\n\n[系统提示：这句话包含待办意图，宠物已自动把「${autoTodo}」加入主人的待办清单。请用一句话简短确认，不要复述整条清单。]`
        }
        // Same for a bulk list: the pet confirms the recorded count.
        if (bulkTodoItems !== null && bulkTodoItems.length > 0) {
          input = `${input}\n\n[系统提示：已把以下 ${bulkTodoItems.length} 条加入主人的待办清单：${bulkTodoItems.map(item => `「${item}」`).join('、')}。请用一两句话简短确认，不要复述整条清单。]`
        }

        const reply = await bridge.prompt(input)
        if (memory !== undefined) {
          memory.recordTurn(text, reply)
          void maybeConsolidate()
        }
        if (reply !== '') ctx.emit(EVENTS.turnDone, { reply })
        return reply
      },
      get snapshot() {
        return bridge.snapshot
      },
      listen: (listener) => bridge.listen(listener),
    }
    ctx.provide('pet', service)
    return async () => {
      disposeListen()
      await bridge.close()
    }
  },
})
