// OpenCode v2 CLI sidebar plugin, registered as "./tui/subagents" in cli.json.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { activeElapsed, formatModel, formatTokens, isActiveSubagent, subagentState } from "./state.mjs"

export default Plugin.define({
  id: "jorgex.subagents",
  setup(context) {
    const [open, setOpen] = createSignal(false)
    const toggle = () => { setOpen((value) => !value) }
    const [starts, setStarts] = createSignal<Record<string, number>>({})
    // Do not infer execution duration from session creation: sessions can run again.
    const stopStarted = context.data.on("session.execution.started", (event) => {
      setStarts((current) => ({ ...current, [event.data.sessionID]: event.created }))
    })
    const stopEnded = context.data.listen(({ details }) => {
      if (!["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.deleted"].includes(details.type)) return
      const id = details.data.sessionID
      if (!id) return
      setStarts((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
    })
    const theme = () => context.theme
    const state = (id: string) => subagentState(
      context.data.session.status(id),
      context.data.session.get(id)?.outcome,
      (context.data.session.permission.list(id) ?? []).length > 0 ||
        (context.data.session.form.list(id) ?? []).length > 0,
    )

    // Keymap layers require the keymap provider, which is not available during setup.
    const unregisterCommands = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "jorgex.subagents.toggle",
            title: "Toggle subagent panel",
            group: "Subagents",
            palette: true,
            slash: { name: "subagents" },
            run: toggle,
          }],
        }))
        return null
      },
    })

    const Card = (props: { sessionID: string }) => {
      createEffect(on(() => props.sessionID, () => setOpen(false)))
      const [now, setNow] = createSignal(Date.now())
      const children = createMemo(() => {
        const root = context.data.session.root(props.sessionID) ?? props.sessionID
        return context.data.session.family(root).filter((id) => id !== root)
      })
      const active = createMemo(() => children().filter((id) => isActiveSubagent(state(id))))
      createEffect(() => {
        if (!open() || active().length === 0) return
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), 1000)
        onCleanup(() => clearInterval(timer))
      })
      const counts = createMemo(() => {
        const result = { running: 0, blocked: 0, done: 0 }
        for (const id of children()) {
          const value = state(id)
          if (value === "running" || value === "blocked" || value === "done") result[value]++
        }
        return result
      })

      return (
        <box flexDirection="column" gap={0}>
          <box flexDirection="column" onMouseDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.stopPropagation()
            toggle()
          }}>
            <text fg={theme().text.base} selectable={false}>
              <b>{`${open() ? "▼" : "▶"} Subagents`}</b>
            </text>
            <Show when={children().length > 0} fallback={<text fg={theme().text.muted}>No subagents</text>}>
              <text selectable={false}>
                <span style={{ fg: theme().text.feedback.warning.base }}>{`• ${counts().running} running`}</span>
                <Show when={counts().blocked > 0}>
                  <span style={{ fg: theme().text.feedback.warning.base }}>{` · ${counts().blocked} needs input`}</span>
                </Show>
                <span style={{ fg: theme().text.feedback.success.base }}>{` · ✓ ${counts().done} done`}</span>
              </text>
            </Show>
          </box>
          <Show when={open()}>
            <Show when={active().length > 0} fallback={<text fg={theme().text.muted}>No active subagents</text>}>
              <For each={active()}>
                {(id) => {
                  const info = () => context.data.session.get(id)
                  const duration = () => activeElapsed(state(id), starts()[id], now())
                  const metrics = () => [duration(), formatTokens(info()?.tokens)].filter(Boolean).join(" · ")
                  const model = () => formatModel(info()?.model)
                  return (
                    <box flexDirection="column" paddingLeft={1} onMouseUp={(event) => {
                      if (event.button !== 0) return
                      event.preventDefault()
                      event.stopPropagation()
                      context.ui.router.navigate({ type: "session", sessionID: id })
                    }}>
                      <box flexDirection="row" gap={1} minWidth={0}>
                        <text fg={theme().text.feedback.warning.base} flexShrink={0} selectable={false}>•</text>
                        <text fg={theme().text.base} flexGrow={1} minWidth={0} wrapMode="none" truncate selectable={false}>
                          <b>{info()?.agent ?? info()?.title ?? id}</b>
                        </text>
                        <Show when={state(id) === "blocked"}>
                          <text fg={theme().text.feedback.warning.base} flexShrink={0} selectable={false}>Needs input</text>
                        </Show>
                      </box>
                      <Show when={metrics()}>
                        <text fg={theme().text.muted} paddingLeft={2} wrapMode="none" truncate selectable={false}>{metrics()}</text>
                      </Show>
                      <Show when={model()}>
                        <text fg={theme().text.muted} paddingLeft={2} wrapMode="none" truncate selectable={false}>
                          {model()}
                        </text>
                      </Show>
                    </box>
                  )
                }}
              </For>
            </Show>
          </Show>
        </box>
      )
    }

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => <Card sessionID={sessionID} />,
    })
    return () => { unregister(); unregisterCommands(); stopStarted(); stopEnded() }
  },
})
