/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as acceso from "../acceso.js";
import type * as agents from "../agents.js";
import type * as auth from "../auth.js";
import type * as desktopSync from "../desktopSync.js";
import type * as http from "../http.js";
import type * as images from "../images.js";
import type * as knowledge from "../knowledge.js";
import type * as links from "../links.js";
import type * as notes from "../notes.js";
import type * as projectLinks from "../projectLinks.js";
import type * as sync from "../sync.js";
import type * as web from "../web.js";
import type * as webAuth from "../webAuth.js";
import type * as workbench from "../workbench.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  acceso: typeof acceso;
  agents: typeof agents;
  auth: typeof auth;
  desktopSync: typeof desktopSync;
  http: typeof http;
  images: typeof images;
  knowledge: typeof knowledge;
  links: typeof links;
  notes: typeof notes;
  projectLinks: typeof projectLinks;
  sync: typeof sync;
  web: typeof web;
  webAuth: typeof webAuth;
  workbench: typeof workbench;
  workspaces: typeof workspaces;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
