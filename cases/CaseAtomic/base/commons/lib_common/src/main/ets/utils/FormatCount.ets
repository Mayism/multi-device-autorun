export class FormatCount {
  static formatToK(number: number) {
    if (Math.abs(number) < 1000) {
      return String(number);
    }
    const valueInK = (number / 1000).toFixed(1);
    return valueInK.replace(/\.0$/, '') + 'k';
  }

  static formatNumberToW(num: number): string {
    if (!num) {
      return '0';
    }
    if (num >= 10000) {
      return (num / 10000).toFixed(1) + '万';
    }
    return String(num)
  }
}