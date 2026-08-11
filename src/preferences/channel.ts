// The main process's "the shared preferences just changed" push channel.
//
// Same placement reasoning as src/menu/commands.ts and
// src/window/close-request.ts: a dependency-free contract module, importable
// from main, preload and renderer alike. Every renderer-INITIATED channel in
// this app is a plain string literal on both sides, because a typo there
// surfaces immediately as "No handler registered for 'file:opne'". A PUSH
// channel has no such backstop -- a typo means the listener simply never
// fires, silently, forever -- so the three push channels this app has all
// pin their name in a shared constant instead. This is the third.
export const PREFERENCES_CHANGED_CHANNEL = 'preferences:changed'
