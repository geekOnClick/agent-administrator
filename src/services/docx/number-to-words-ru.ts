/**
 * Конвертация суммы в рублях в расшифровку словами на русском языке,
 * например: 25062.99 -> "Двадцать пять тысяч шестьдесят два рубля девяносто девять копеек".
 */

const ONES_MALE = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const ONES_FEMALE = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TEENS = [
  'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать',
  'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'
];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

function pluralForm(n: number, forms: [string, string, string]): string {
  const n100 = n % 100;
  const n10 = n100 % 10;
  if (n100 > 10 && n100 < 20) return forms[2];
  if (n10 === 1) return forms[0];
  if (n10 >= 2 && n10 <= 4) return forms[1];
  return forms[2];
}

function threeDigitsToWords(n: number, female: boolean): string {
  const words: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds) words.push(HUNDREDS[hundreds]);
  if (rest >= 10 && rest < 20) {
    words.push(TEENS[rest - 10]);
  } else {
    const tens = Math.floor(rest / 10);
    const ones = rest % 10;
    if (tens) words.push(TENS[tens]);
    if (ones) words.push((female ? ONES_FEMALE : ONES_MALE)[ones]);
  }
  return words.join(' ');
}

function integerToWords(n: number, femaleUnits = false): string {
  if (n === 0) return 'ноль';

  const billions = Math.floor(n / 1_000_000_000) % 1000;
  const millions = Math.floor(n / 1_000_000) % 1000;
  const thousands = Math.floor(n / 1000) % 1000;
  const units = n % 1000;

  const parts: string[] = [];

  if (billions) {
    parts.push(threeDigitsToWords(billions, false));
    parts.push(pluralForm(billions, ['миллиард', 'миллиарда', 'миллиардов']));
  }
  if (millions) {
    parts.push(threeDigitsToWords(millions, false));
    parts.push(pluralForm(millions, ['миллион', 'миллиона', 'миллионов']));
  }
  if (thousands) {
    parts.push(threeDigitsToWords(thousands, true));
    parts.push(pluralForm(thousands, ['тысяча', 'тысячи', 'тысяч']));
  }
  if (units || parts.length === 0) {
    parts.push(threeDigitsToWords(units, femaleUnits));
  }

  return parts.filter(Boolean).join(' ');
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Возвращает расшифровку суммы в рублях и копейках словами на русском,
 * например: amountToWordsRu(25062.99) -> "Двадцать пять тысяч шестьдесят два рубля девяносто девять копеек".
 */
export function amountToWordsRu(amount: number): string {
  const rounded = Math.round(Math.abs(amount) * 100) / 100;
  const rubles = Math.floor(rounded);
  const kopecks = Math.round((rounded - rubles) * 100);

  const rublesWords = integerToWords(rubles);
  const rublesLabel = pluralForm(rubles, ['рубль', 'рубля', 'рублей']);

  if (kopecks === 0) {
    return `${capitalize(rublesWords)} ${rublesLabel}`;
  }

  const kopecksWords = integerToWords(kopecks, true);
  const kopecksLabel = pluralForm(kopecks, ['копейка', 'копейки', 'копеек']);

  return `${capitalize(rublesWords)} ${rublesLabel} ${kopecksWords} ${kopecksLabel}`;
}
