export type Item = {
	type: 'f' | 'd';
	name: string;
	fullName: ItemPath;
	lastMod: number; //Timestamp
	size: number;
}

export type ItemPath = string & {__type: 'ItemPath'};
export type Base64Str = string & {__type: 'Base64Str'};

export type EncryptionKey = CryptoKey & {__type: 'EncryptionKey'};
export type MACKey = CryptoKey & {__type: 'MACKey'};