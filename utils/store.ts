import { configureStore } from '@reduxjs/toolkit';
import app from '@/slices/app.slice';
import messages from '@/slices/messages.slice';
import nodes from '@/slices/nodes.slice';
import config from '@/utils/config';
import { Env } from '@/types/env';
import logger from 'redux-logger';

const isDev = config.env === Env.dev || __DEV__;

const store = configureStore({
  reducer: {
    app,
    messages,
    nodes,
  },
  middleware: getDefaultMiddleware => {
    const base = getDefaultMiddleware({ serializableCheck: false });
    return isDev ? base.concat(logger) : base;
  },
  devTools: isDev,
});

export type State = ReturnType<typeof store.getState>;
export type Dispatch = typeof store.dispatch;

export default store;

