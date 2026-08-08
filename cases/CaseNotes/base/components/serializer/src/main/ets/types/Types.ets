/**
 * 对应MutableStyledString
 */
export interface SerializedMutableStyledString {
  content: string;
  options: Array<SerializedStyleOptions>;
}


/**
 * 对应StyleOptions
 */
export interface SerializedStyleOptions {
  start: number;
  length: number;
  styledKey: StyledStringKey;
  styledValue: SerializedStyledStringValue;
}

/**
 * 对应StyledStringValue
 */
export interface SerializedStyledStringValue {
}