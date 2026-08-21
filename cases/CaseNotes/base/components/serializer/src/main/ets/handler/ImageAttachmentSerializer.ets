import { image } from '@kit.ImageKit';
import { fileIo, fileIo as fs } from '@kit.CoreFileKit';
import { SerializedStyledStringValue } from '../types/Types';

export interface SerializedImageAttachment extends SerializedStyledStringValue {
  uri: string;
  size?: SerializeSizeOptions;
  objectFit?: ImageFit;
}

declare interface SerializeSizeOptions {
  width?: number;
  height?: number;
}

export class ImageAttachmentSerializer {
  static serialize(value: ImageAttachment, uri: string, uiContext: UIContext): SerializedImageAttachment {
    return {
      uri: uri,
      size: ImageAttachmentSerializer.serializeSize(value.size, uiContext),
      objectFit: value.objectFit,
    };
  }

  static deserialize(data: SerializedImageAttachment): ImageAttachment {
    return new ImageAttachment({
      value: ImageAttachmentSerializer.loadPixelMap(data.uri),
      size: {
        width: data.size?.width,
        height: data.size?.height
      } as SizeOptions,
      objectFit: data.objectFit,
    });
  }

  private static loadPixelMap(uri: string): image.PixelMap {
    let file: fs.File = null!;
    try {
      file = fs.openSync(uri, fileIo.OpenMode.READ_ONLY)
      let imageSource: image.ImageSource = image.createImageSource(file.fd);
      return imageSource.createPixelMapSync();
    } finally {
      fs.close(file.fd)
    }
  }

  private static serializeSize(size: SizeOptions | undefined, uiContext: UIContext): SerializeSizeOptions {
    if (!size) {
      return {}
    }
    const result: SerializeSizeOptions = {};
    if (size.width !== undefined) {
      let w: number = size.width as number;
      result.width = uiContext.px2vp(w)
    }
    if (size.height !== undefined) {
      let h: number = size.height as number;
      result.height = uiContext.px2vp(h)
    }
    return result;
  }
}