import {isId} from './thread-catalog.mjs';

export function resolveLaunchThreadId(requestedId, snapshot) {
  return [requestedId, snapshot?.window?.launchThreadId, snapshot?.selectedId, snapshot?.scope?.threadId].find(isId) ?? null;
}
