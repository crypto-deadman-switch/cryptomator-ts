import { AES } from "@stablelib/aes";
import { SIV } from "@stablelib/siv";
import { scrypt } from "scrypt-js";
import type { DataProvider, ProgressCallback } from "./DataProvider";
import type { DirID, EncryptionKey, Item, ItemPath, MACKey } from "./types";
import { base64url, jwtVerify, SignJWT } from "jose";
import { DecryptionError, DecryptionTarget, ExistsError, InvalidSignatureError } from "./Errors";
import { EncryptedDir } from "./encrypted/EncryptedDir";
import { EncryptedFile } from "./encrypted/EncryptedFile";
import { Base64 } from "js-base64";
import b32 from 'base32-encode'
import { v4 } from "uuid";
import type { EncryptedItem } from "./encrypted/EncryptedItemBase";

type VaultConfigHeader = {
	kid: string;
	typ: 'JWT';
	alg: 'HS256' | 'HS384' | 'HS512';
}

type VaultConfig = {
	format: number;
	shorteningThreshold: number;
	jti: string;
	cipherCombo: 'SIV_CTRMAC';
}

type Masterkey = {
	primaryMasterKey: string;
	hmacMasterKey: string;
	scryptBlockSize: number;
	scryptCostParam: number;
	scryptSalt: string;
	versionMac: string;
	version: 999;
}

type VaultSettings = {
	/**
	 * Currently, only version 8 is supported.
	 */
	format: number;
	/**
	 * Defaults to 220 if not provided.
	 */
	shorteningThreshold: number;
	/**
	 * Defaults to 32768 as per recommendation specified at https://github.com/cryptomator/cryptomator/issues/611.
	 */
	scryptCostParam: number;
	/**
	 * Defaults to 8.
	 */
	scryptBlockSize: number;
}

type CreateVaultOpts = {
	/**
	 * Name of this vault.
	 * If set, a subdirectory with this name will be created under the specified folder.
	 */
	name: string;
} | {
	name: null;
	/**
	 * If true, the vault will be created created directly in the supplied directory.
	 * In other words, the vault.cryptomator and masterkey.cryptomator will be created in the specified directory.
	 */
	createHere: true;
}

type QueryOpts = {
	/**
	 * Max number of queries that should be done in batch.
	 * Defaults to -1, which represents infinite
	 * It is recommended that you set this to certain value so that you don't end up mass querying the server.
	 */
	concurrency: number;
}

/**
 * Vault create function will call the callback function with these values inside to indicate which step the function is currently stuck in.
 * DupeCheck: Check if vault can be created by verifying there are no files/folders with the same name
 * KeyGen: Generating keys, scrypt function takes a bit of time
 * CreatingFiles: Creating and sending *.cryptomator files
 * CreatingRoot: Creating d directory and root directory
 */
export enum CreationStep{
	DupeCheck,
	KeyGen,
	CreatingFiles,
	CreatingRoot
}

/**
 * Cryptomator vault object
 */
export class Vault {
	private constructor(
		public provider: DataProvider,
		public dir: string,
		public name: string,
		public encKey: EncryptionKey,
		public macKey: MACKey,
		private siv: SIV,
		public vaultSettings: VaultSettings,
		public queryOpts: QueryOpts
	){}

	/**
	 * Create a vault.
	 * @param provider File system provider
	 * @param dir Directory to create this vault
	 * @param password Vault password
	 * @param options Vault options
	 * @param options.create Mandatory options regarding how vault should be created
	 * @param options.vault Option that determines vault configuration
	 * @param options.queryOpts Option that controls how often the data provider should be queried
	 * @param options.callback Function to call once a time consuming operation is completed
	 * @returns The vault object for the newly created vault
	 *
	 * Currently, custom masterkey.cryptomator location and algorithm other than HS256 is not supported.
	 * As a result, vault.cryptomator's decoded header will always be the same.
	 */
	static async create(
		provider: DataProvider,
		dir: string,
		password: string,
		options: {
			create: CreateVaultOpts,
			vault?: Partial<VaultSettings>
			queryOpts?: QueryOpts,
			callback?: (step: CreationStep) => void
		}
	) {
		let name: string;
		if(options.callback) options.callback(CreationStep.DupeCheck);
		if (dir.endsWith('/')) dir = dir.slice(0, -1);
		if (options.create.name) {
			dir = dir + '/' + options.create.name;
			if(await provider.exists(dir)) throw new ExistsError(dir);
			name = options.create.name;
			await provider.createDir(dir, true);
		} else {
			const checkExists = async (dir: string) => {
				if(await provider.exists(dir)) throw new ExistsError(dir);
			}
			await Promise.all([
				checkExists(`${dir}/masterkey.cryptomator`),
				checkExists(`${dir}/vault.cryptomator`),
				checkExists(`${dir}/d`)
			]);
			const splitted = dir.split('/');
			name = splitted[splitted.length - 1] ?? 'Root';
		}
		if(options.callback) options.callback(CreationStep.KeyGen);
		const sBlockSize = options.vault?.scryptBlockSize ?? 8;
		const sCostParam = options.vault?.scryptCostParam ?? 32768;
		const format = options.vault?.format ?? 8;
		const salt = crypto.getRandomValues(new Uint8Array(32));
		const kekBuffer = await scrypt(new TextEncoder().encode(password), salt, sCostParam, sBlockSize, 1, 32);
		if(options.callback) options.callback(CreationStep.CreatingFiles);
		const encKeyBuffer = crypto.getRandomValues(new Uint8Array(32));
		const macKeyBuffer = crypto.getRandomValues(new Uint8Array(32));
		const buffer = new Uint8Array(64);
		buffer.set(macKeyBuffer, 0);
		buffer.set(encKeyBuffer, 32);
		const siv = new SIV(AES, buffer);
		buffer.set(encKeyBuffer, 0);
		buffer.set(macKeyBuffer, 32);

		const kek = await crypto.subtle.importKey('raw', kekBuffer, 'AES-KW', false, ['wrapKey']);
		kekBuffer.fill(0);
		const encKey = await crypto.subtle.importKey('raw', encKeyBuffer, 'AES-CTR', true, ['encrypt', 'decrypt']) as EncryptionKey;
		const macKey = await crypto.subtle.importKey('raw', macKeyBuffer, {
			name: 'HMAC',
			hash: {name: 'SHA-256'}
		}, true, ['sign']) as MACKey;

		encKeyBuffer.fill(0);
		macKeyBuffer.fill(0);

		const wrappedEncKey = new Uint8Array(await crypto.subtle.wrapKey(
			'raw',
			encKey,
			kek,
			'AES-KW'
		));

		const wrappedMacKey = new Uint8Array(await crypto.subtle.wrapKey(
			'raw',
			macKey,
			kek,
			'AES-KW'
		));

		const versionMac = new Uint8Array(await crypto.subtle.sign('HMAC', macKey, new TextEncoder().encode(`${format}`)));
		const mk: Masterkey = {
			primaryMasterKey: Base64.fromUint8Array(wrappedEncKey),
			hmacMasterKey: Base64.fromUint8Array(wrappedMacKey),
			scryptBlockSize: sBlockSize,
			scryptCostParam: sCostParam,
			scryptSalt: Base64.fromUint8Array(salt),
			versionMac: Base64.fromUint8Array(versionMac),
			version: 999
		}

		const vaultFile = await new SignJWT({
			format: format,
			shorteningThreshold: options.vault?.shorteningThreshold ?? 220,
			jti: v4(),
			cipherCombo: 'SIV_CTRMAC'
		}).setProtectedHeader({
			alg: 'HS256',
			kid: 'masterkeyfile:masterkey.cryptomator',
			typ: 'JWT'
		}).sign(buffer);
		buffer.fill(0);
		try {
			await Promise.all([
				provider.writeFile(`${dir}/masterkey.cryptomator`, JSON.stringify(mk)),
				provider.writeFile(`${dir}/vault.cryptomator`, vaultFile),
				provider.createDir(`${dir}/d`)
			]);
			if(options.callback) options.callback(CreationStep.CreatingRoot);

			const vault = new Vault(provider, dir, name, encKey, macKey, siv, {
				format: options.vault?.format ?? 8,
				shorteningThreshold: options.vault?.shorteningThreshold ?? 220,
				scryptCostParam: sCostParam,
				scryptBlockSize: sBlockSize
			}, options.queryOpts ?? {concurrency: -1});
			const rootDir = await vault.getRootDirPath();
			await provider.createDir(rootDir, true);

			return vault;
		} catch (e) {
			if(name) await provider.removeDir(dir);
			else await Promise.allSettled([
				provider.removeFile(`${dir}/masterkey.cryptomator`),
				provider.removeFile(`${dir}/vault.cryptomator`),
				provider.removeDir(`${dir}/d`)
			]);
			throw e;
		}

	}

	/**
	 * Open an existing vault
	 * @param provider Data provider
	 * @param dir Directory of the vault that contains 'masterkey.cryptomator' and 'd' directory
	 * @param password Password of the vault
	 * @param name Name of the vault, may be null
	 * @param options Various options to pass to decrypting vault
	 * @param options.vaultFile: Absolute directory of the vault.cryptomator file
	 * @param options.masterkeyFile: Absolute directory of the masterkey.cryptomator file
	 * @param options.onKeyLoad: Callback that is called when the vault.cryptomator and masterkey.cryptomator is loaded
	 * @param options.queryOpts: Parameter that limits the query sent to the remote storage
	 * @throws DecryptionError if the given password is wrong
	 * @throws InvalidSignatureError if the integrity of vault.cryptomator file cannot be verified
	 */
	static async open(
			provider: DataProvider,
			dir: string,
			password: string,
			name: string,
			options?: {
				vaultFile?: ItemPath
				masterkeyFile?: ItemPath
				onKeyLoad?: () => void,
				queryOpts?: QueryOpts
			}
		) {
		if (dir.endsWith('/')) dir = dir.slice(0, -1);
		const loadTask = [
			provider.readFileString(options?.vaultFile ? options.vaultFile : dir + '/vault.cryptomator'),
			provider.readFileString(options?.masterkeyFile ? options.masterkeyFile : dir + '/masterkey.cryptomator')
		];
		const [token, rawMk] = await Promise.all(loadTask);
		const mk = JSON.parse(rawMk) as Masterkey;
		if(options?.onKeyLoad) options.onKeyLoad();
		const kekBuffer = await scrypt(new TextEncoder().encode(password), Base64.toUint8Array(mk.scryptSalt), mk.scryptCostParam, mk.scryptBlockSize, 1, 32);
		const kek = await crypto.subtle.importKey(
			'raw',
			kekBuffer,
			'AES-KW',
			false,
			['unwrapKey']
		);
		kekBuffer.fill(0);
		let encKey: EncryptionKey;
		try{
			encKey = await crypto.subtle.unwrapKey(
				'raw',
				Base64.toUint8Array(mk.primaryMasterKey),
				kek,
				'AES-KW',
				'AES-CTR',
				true,
				['encrypt', 'decrypt']
			) as EncryptionKey;
		} catch(e) {
			throw new DecryptionError(DecryptionTarget.Vault, null);
		}
		const extractedEnc = new Uint8Array(await crypto.subtle.exportKey('raw', encKey));
		const macKey = await crypto.subtle.unwrapKey(
			'raw',
			Base64.toUint8Array(mk.hmacMasterKey),
			kek,
			'AES-KW',
			{
				name: 'HMAC',
				hash: {name: 'SHA-256'}
			},
			true,
			['sign']
		) as MACKey;
		const extractedMac = new Uint8Array(await crypto.subtle.exportKey('raw', macKey));
		const buffer = new Uint8Array(64);
		buffer.set(extractedMac, 0);
		buffer.set(extractedEnc, 32);
		const siv = new SIV(AES, buffer);
		buffer.set(extractedEnc, 0);
		buffer.set(extractedMac, 32);
		extractedMac.fill(0);
		extractedEnc.fill(0);
		let vaultConfig: VaultConfig;
		try {
			const res = await jwtVerify(token, buffer);
			vaultConfig = res.payload as VaultConfig;
		} catch(e) {
			throw new InvalidSignatureError(DecryptionTarget.Vault);
		}
		buffer.fill(0);
		return new Vault(provider, dir, name, encKey, macKey, siv, {
			format: vaultConfig.format,
			shorteningThreshold: vaultConfig.shorteningThreshold,
			scryptCostParam: mk.scryptCostParam,
			scryptBlockSize: mk.scryptBlockSize
		}, options?.queryOpts ?? {concurrency: -1});
	}

	/**
	 * Accepts a directory ID, and returns the directory of the corresponding folder
	 * @param dirId ID of the directory
	 * @returns Corresponding _absolute_ directory
	 */
	async getDir(dirId: DirID){
		const sivId = this.siv.seal([], new TextEncoder().encode(dirId));
		const ab = await crypto.subtle.digest('SHA-1', sivId);
		const dirHash = b32(ab, 'RFC4648');
		return `${this.dir}/d/${dirHash.substring(0, 2)}/${dirHash.substring(2)}` as ItemPath;
	}

	/**
	 * List all files under a given directory ID
	 * @param dirId ID of the directory
	 * @returns Items within that folder, not ready for decryption
	 */
	async listEncrypted(dirId: DirID){
		const dir = await this.getDir(dirId);
		const items = await this.provider.listItems(dir);
		return items.filter(i => (i.name.endsWith('.c9r') || i.name.endsWith('.c9s')) && i.name !== 'dirid.c9r'); // TODO: Add a function that decrypts this
	}

	/**
	 * Get directory of the root directory
	 * @returns Encrypted directory that corresponds to the root directory (Directory with ID of "")
	 */
	async getRootDirPath(){
		return await this.getDir('' as DirID);
	}

	/**
	 * Decrypts a file name
	 * @param item Encrypted file
	 * @param parent ID of the parent directory
	 * @returns Decrypted file name as string
	 * @throws DecryptionError If file name cannot be decrypted
	 */
	async decryptFileName(item: Item, parent: DirID): Promise<string>{
		let name;
		if(item.name.endsWith('.c9r')) name = item.name.slice(0, -4);
		else if(item.name.endsWith('.c9s')) name = await this.provider.readFileString(item.fullName + '/name.c9s');
		else name = item.name;
		const decrypted = this.siv.open([new TextEncoder().encode(parent)], base64url.decode(name));
		if(decrypted === null) throw new DecryptionError(DecryptionTarget.ItemName, item);
		return new TextDecoder().decode(decrypted);
	}

	/**
	 * Return an encrypted file name
	 * @param name Original name of the file
	 * @param parent Directory ID of the parent folder
	 * @returns Encrypted file name, with padding but not .c9r
	 */
	async encryptFileName(name: string, parent: DirID): Promise<string>{
		const encrypted = this.siv.seal([new TextEncoder().encode(parent)], new TextEncoder().encode(name));
		const converted = base64url.encode(encrypted);
		const paddingNeeded = converted.length % 4;
		if(paddingNeeded) return converted + '='.repeat(4 - paddingNeeded);
		else return converted;
	}

	/**
	 * List all files, ready for decrypting contents
	 * @param dirId ID of the directory
	 * @param callback.type Optional callback that gets called when the type of file is determined
	 * @param callback.name Optional callback that gets called upon successful name decryption
	 * @returns Encrypted items in that directory
	 */
	async listItems(dirId: DirID, callback?: {
		type?: ProgressCallback,
		name?: ProgressCallback
	}): Promise<EncryptedItem[]>{
		const enc = await this.listEncrypted(dirId);
		const pendingNameList: Promise<string>[] = [];
		let nameDone = 0;
		const getFileName = async (item: Item) => {
			const ret = await this.decryptFileName(item, dirId);
			nameDone++;
			if(callback?.name) callback.name(nameDone, enc.length);
			return ret;
		}
		for(const item of enc) pendingNameList.push(getFileName(item));
		const names = await Promise.all(pendingNameList);
		let done = 0;
		const getItemObj = async (item: Item, name: string) => {
			let type;
			let shortened = false;
			if(item.type === 'd' && item.fullName.endsWith('.c9s')){
				const contents = await this.provider.listItems(item.fullName);
				if(contents.find(i => i.name === 'contents.c9r')) type = 'f';
				else type = 'd';
				shortened = true;
			} else type = item.type;
			done++;
			if (callback?.type) callback.type(done, names.length);
			if(type === 'f') return new EncryptedFile(this, item.name, item.fullName, name, dirId, item.lastMod, shortened);
			else return await EncryptedDir.open(this, item.name, item.fullName, name, dirId, item.lastMod, shortened);
		}
		const tasks = enc.map((item, i) => getItemObj(item, names[i]));
		if(this.queryOpts.concurrency === -1) return await Promise.all(tasks);
		else {
			const chunks = [];
			let res: EncryptedItem[] = [];
			while(tasks.length) chunks.push(tasks.splice(0, this.queryOpts.concurrency));
			for(const c of chunks) res = res.concat(await Promise.all(c));
			return res;
		}
	}

	/**
	 * Create a directory under a given directory ID
	 * @param name Name of the folder
	 * @param parent Directory ID of the parent folder
	 * @param fixedId ID of the directory to create, will be random if not specified
	 * @returns New EncryptedDir object that corresponds to the new directory
	 */
	async createDirectory(name: string, parent: DirID, fixedId?: DirID | null){
		const dirId = ((fixedId || fixedId === null) ? fixedId : v4()) as DirID;
		const encDir = await this.getDir(parent);
		const encName = await this.encryptFileName(name, parent);
		const needsToBeShortened = encName.length > this.vaultSettings.shorteningThreshold;
		let dir;
		if(needsToBeShortened){
			const shortened = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(encName));
			const shortDir = base64url.encode(new Uint8Array(shortened));
			dir = `${encDir}/${shortDir}.c9s`
		} else dir = `${encDir}/${encName}.c9r`;
		const dirFolder = await this.getDir(dirId);
		try{
			await Promise.all([
				this.provider.createDir(dir, true),
				this.provider.createDir(dirFolder, true)
			]);
			const tasks = [
				this.provider.writeFile(`${dir}/dir.c9r`, dirId)
			];
			if (needsToBeShortened) tasks.push(this.provider.writeFile(`${dir}/name.c9s`, encName));
			await Promise.all(tasks);
		} catch (e) {
			await Promise.allSettled([
				this.provider.removeDir(dir),
				this.provider.removeDir(dirFolder)
			]);
			throw e;
		}
		return await EncryptedDir.open(this, encName, dir as ItemPath, name, parent, new Date(), needsToBeShortened, {dirId: dirId});
		// await this.provider.writeFile(`${dirFolder}/dirid.c9r`, ) TODO: https://docs.cryptomator.org/en/latest/security/architecture/#backup-directory-ids
	}

	/**
	 * Get EncryptedDir that corresponds to root directory
	 * @returns EncryptedDir that corresponds to the root folder
	 */
	async getRootDir(){
		return await EncryptedDir.open(this, '', await this.getRootDirPath(), 'Root', null, new Date(), false, {dirId: '' as DirID});
	}

	/**
	 * Create a directory in root
	 * @param name Name of the folder
	 * @returns New EncryptedDir object that corresponds to the new directory
	 */
	async createDirAtRoot(name: string){
		return await this.createDirectory(name, '' as DirID);
	}

	/**
	 * Delete a file the EncryptedFile object corresponds to. Object passed to this function should never be used.
	 * @param f EncryptedFile object of the file to delete
	 */
	async deleteFile(f: EncryptedFile) {
		await this.provider.removeFile(f.fullName);
	}

	/**
	 * Delete a directory the EncryptedDir corresponds to. Anything within this directory will be deleted recursively. Anything deleted because of this should never be used.
	 * @param d EncryptedDir object of the directory to delete
	 * @param onDiscover A callback that is called whenever a directory has been searched successfully. If toDiscover is 0, it can be assumed that delete operation is in progress.
	 */
	async deleteDir(d: EncryptedDir, onDiscover?: (discovered: number, toDiscover: number) => void) {
		const dirIdList: DirID[] = [await d.getDirId()];
		const dirList: string[] = [d.fullName];
		while(dirIdList.length){
			const current = dirIdList.pop() as DirID;
			const items = await this.listItems(current);
			for(const i of items){
				if(i.type === 'd') dirIdList.push(await i.getDirId());
				dirList.push(i.fullName);
			}
			if(onDiscover) onDiscover(dirList.length, dirIdList.length);
		}
		const delOps: Promise<void>[] = [];
		for(const d of dirList) delOps.push(this.provider.removeDir(d));
		if(this.queryOpts.concurrency === -1) await Promise.all(delOps);
		else {
			const chunks = [];
			while(delOps.length) chunks.push(delOps.splice(0, this.queryOpts.concurrency));
			for(const c of chunks) await Promise.all(c);
		}
	}


	/**
	 * Move multiple items into a chosen folder.
	 * Not all items needs to be from a single folder.
	 * @param items List of items to move
	 * @param to Move operation destination
	 */
	static async move(items: EncryptedItem[], to: DirID){
		await Promise.all(items.map(v => v.move(to)));
	}
}
