import { createMemo, createSignal } from "solid-js"
import { pipe, flatMap, entries, filter, map } from "remeda"
import * as fuzzysort from "fuzzysort"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { usePermission } from "../context/permission"
import { useRoute } from "../context/route"
import { useToast } from "../ui/toast"
import { sortModelOptions } from "./dialog-model"

// Per-session picker for the model-gated review classifier. Mirrors the main
// model dialog, but writes the selection to the permission context keyed by the
// active sessionID; the choice is sent with each classify call and never
// persisted. The first entry clears the override back to the configured default.
type ReviewModelValue = { providerID: string; modelID: string } | undefined

// opencode's own small-model families (Provider.smallModelFamilyPriority plus the
// copilot-only gpt-mini). Members are marked "Fast" and surfaced in a recommended
// section, since the classifier runs under a 15s deadline. Reasoning models work
// (they run at the lowest exposed effort and their verdict is honored) but are kept
// out of the recommendation because they are slower and can hit the deadline.
const SMALL_FAMILIES = new Set(["gemini-flash", "gpt-mini", "gpt-nano", "claude-haiku"])
// Server family preference order (Provider.getSmallModel), used for the best-effort label.
const SMALL_FAMILIES_PRIORITY = ["gemini-flash", "gpt-nano", "claude-haiku"]
const isFast = (info: { family?: string }) => !!info.family && SMALL_FAMILIES.has(info.family)
const isReasoning = (info: { capabilities?: { reasoning?: boolean } }) => info.capabilities?.reasoning === true

export function DialogReviewModel() {
  const sync = useSync()
  const local = useLocal()
  const permission = usePermission()
  const route = useRoute()
  const dialog = useDialog()
  const toast = useToast()
  const [query, setQuery] = createSignal("")

  const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  // Best-effort label for what "Default" resolves to, mirroring the server chain
  // (auto_approve.model, then small_model, then the session provider's small-model
  // family pick). A provider plugin can still override the family pick server-side,
  // so the family result is a guess, not a promise.
  const resolvedDefault = createMemo(() => {
    const configured = sync.data.config.auto_approve?.model ?? sync.data.config.small_model
    if (typeof configured === "string" && configured.length > 0)
      return {
        label: configured,
        source:
          sync.data.config.auto_approve?.model !== undefined
            ? "From auto_approve.model"
            : "From small_model",
      }
    const current = local.model.current()
    if (!current) return undefined
    if (current.providerID === "azure" || current.providerID === "azure-cognitive-services") return undefined
    const provider = sync.data.provider.find((item) => item.id === current.providerID)
    if (!provider) return undefined
    const priority = current.providerID.startsWith("opencode")
      ? ["gpt-nano"]
      : current.providerID.startsWith("github-copilot")
        ? ["gpt-mini", ...SMALL_FAMILIES_PRIORITY]
        : SMALL_FAMILIES_PRIORITY
    const models = Object.entries(provider.models).sort(
      ([aID, a], [bID, b]) =>
        (b.release_date ?? "").localeCompare(a.release_date ?? "") || bID.localeCompare(aID),
    )
    for (const family of priority) {
      const hit = models.find(([_, info]) => info.family === family)
      if (hit) return { label: `${provider.id}/${hit[0]}`, source: "Session provider's small model pick" }
    }
    return undefined
  })

  function onSelect(value: ReviewModelValue) {
    const id = sessionID()
    if (!id) {
      toast.show({ message: "Open a session to set its review model", variant: "info" })
      dialog.clear()
      return
    }
    if (value) {
      // Validate the pick against the live provider list, and note a reasoning model:
      // it runs at the lowest exposed effort, but is slower and can hit the 15s deadline
      // (which fails closed to a prompt).
      const info = sync.data.provider.find((provider) => provider.id === value.providerID)?.models[value.modelID]
      if (!info) {
        toast.show({ variant: "error", message: `${value.providerID}/${value.modelID} is not an available model` })
        dialog.clear()
        return
      }
      if (isReasoning(info)) {
        toast.show({
          variant: "info",
          message: `${info.name ?? value.modelID} is a reasoning model — it runs at lowest effort, but may be slower and can hit the 15s classification deadline`,
        })
      }
    }
    permission.setReviewModel(id, value)
    dialog.clear()
  }

  const options = createMemo(() => {
    const needle = query().trim()

    const resolved = resolvedDefault()
    const defaultOption = {
      value: undefined as ReviewModelValue,
      title: resolved ? `Default (${resolved.label})` : "Default (configured or fallback)",
      releaseDate: "",
      description: resolved ? resolved.source : "Use auto_approve.model, else the session provider's small model",
      category: "Review classifier",
      onSelect() {
        onSelect(undefined)
      },
    }

    const allOptions = pipe(
      sync.data.provider,
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          map(([model, info]) => ({
            value: { providerID: provider.id, modelID: model } as ReviewModelValue,
            title: info.name ?? model,
            releaseDate: info.release_date ?? "",
            description: provider.name,
            category: provider.name,
            footer: isFast(info) ? "Fast" : undefined,
            fast: isFast(info) && !isReasoning(info),
            onSelect() {
              onSelect({ providerID: provider.id, modelID: model })
            },
          })),
          (list) => sortModelOptions(list, false),
        ),
      ),
    )

    if (needle) {
      return sortModelOptions(
        fuzzysort.go(needle, allOptions, { keys: ["title", "category"] }).map((x) => x.obj),
        false,
      )
    }

    const recommended = allOptions
      .filter((option) => option.fast)
      .map((option) => ({ ...option, category: "Fast (recommended)" }))
    const recommendedKeys = new Set(recommended.map((option) => `${option.value!.providerID}/${option.value!.modelID}`))
    const rest = allOptions.filter(
      (option) => !recommendedKeys.has(`${option.value!.providerID}/${option.value!.modelID}`),
    )

    return [defaultOption, ...recommended, ...rest]
  })

  return (
    <DialogSelect<ReviewModelValue>
      options={options()}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title="Select review model"
      current={sessionID() ? permission.reviewModel(sessionID()!) : undefined}
    />
  )
}
