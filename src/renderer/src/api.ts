import type { RendererApi } from '@shared/ipc'

/** Typed accessor for the preload bridge. */
export const api: RendererApi = window.api
