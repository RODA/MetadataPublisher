export interface InputFilters {
  setInputFilter: (textbox: HTMLInputElement | null, inputFilter: (value: string) => boolean) => void;
  setIntegers: (items: string[] | HTMLInputElement[], prefix?: string) => void;
  setSignedIntegers: (items: string[] | HTMLInputElement[], prefix?: string) => void;
  setDouble: (items: string[] | HTMLInputElement[], prefix?: string) => void;
  setSignedDouble: (items: string[] | HTMLInputElement[], prefix?: string) => void;
}

