export enum AVPlayerState {
  IDLE = 'idle',
  INITIALIZED = 'initialized',
  PREPARED = 'prepared',
  PLAYING = 'playing',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  STOPPED = 'stopped',
  RELEASED = 'released',
  ERROR = 'error'
}

export interface VideoPlayerData {
  getVideoId: () => string;
  getVideoUrl: () => string;
  getCoverUrl: () => string | undefined;
  getVideoTitle: () => string;
  getVideoDuration: () => number;
  isNeedVip: () => boolean;
  setVideoDuration: (duration: number) => void;
}

/**
 * 断点名称
 */
export enum BreakpointNameEnum {
  SM = 'sm',
  MD = 'md',
  LG = 'lg',
  XL = 'xl',
}

export enum PageNameEnum {
  VIDEO_LANDSCAPE_PAGE = 'LandscapeVideo',
  REMOTE_CONTROL_PAGE = 'PageCastControl',
}