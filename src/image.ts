/**
 * 图片解码：单张失败只标记/回传该项，绝不影响其它页。
 */

export function decodeBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      // onload 在损坏文件上有时仍会触发（0 尺寸）；做一次显式校验。
      if (!img.naturalWidth || !img.naturalHeight) {
        URL.revokeObjectURL(url);
        reject(new Error('image decoded with zero size'));
        return;
      }
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image decode failed'));
    };
    img.src = url;
  });
}

export function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  width: number,
  height: number
): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);
}
