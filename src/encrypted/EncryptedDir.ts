import type { Directory, DirID, ItemPath } from "../types";
import { Vault } from "../Vault";
import { EncryptedFile } from "./EncryptedFile";
import { EncryptedItemBase } from "./EncryptedItemBase";

export class EncryptedDir extends EncryptedItemBase implements Directory{
	type: 'd';
	private dirId: null | DirID;

	/**
	 * Construct a directory object. Use this instead of default constructor as this provides additional options.
	 * @param vault Vault object that can decrypt this directory
	 * @param name Encrypted directory name
	 * @param fullName *Encrypted* directory that corresponds to this object (The folder that contains dir.c9r)
	 * @param decryptedName Name of the folder after decryption
	 * @param parent Directory ID of the parent folder
	 * @param lastMod Last modification date
	 * @param options.cacheDirId If true, the ID of the directory will be queried, and cached into the object.
	 * @param options.dirId If set, this ID will be cached and used. Do not set this if you are not certain it is the correct directory ID. Overrides options.cacheDirId
	 * @returns EncryptedDir object
	 *
	 * If this object corresponds to the root folder, then the following are always true:
	 * - this.parent is null
	 * - this.name is "" (empty)
	 * - this.decryptedName is "root"
	 * - this.getDirId() always returns ""
	 */
	static async open(
		vault: Vault,
		name: string,
		fullName: ItemPath,
		decryptedName: string,
		parent: DirID | null,
		lastMod: Date,
		shortened: boolean,
		options?: {
			cacheDirId?: boolean,
			dirId?: DirID
		}
	){
		let dirId: DirID | null = null;
		if(options?.dirId) dirId = options.dirId;
		else if(options?.cacheDirId) dirId = await vault.provider.readFileString(fullName + '/dir.c9r') as DirID;
		return new EncryptedDir(vault, name, fullName, decryptedName, parent, lastMod, dirId, shortened);
	}

	private constructor(vault: Vault, name: string, fullName: ItemPath, decryptedName: string, parent: DirID | null, lastMod: Date, dirId: DirID | null, shortened: boolean){
		super(vault, name, fullName, decryptedName, parent, lastMod, shortened);
		this.dirId = dirId;
		this.type = 'd';
	}

	/**
	 * Get the ID of this directory
	 * @param clearCache Query the provider to get updated directory ID.
	 * @returns ID of this directory
	 *
	 * Calling this method will cache ID if it is not already.
	 */
	async getDirId(clearCache?: true){
		if(this.parentId === null) return '' as DirID;
		if(clearCache || !this.dirId) this.dirId = await this.vault.provider.readFileString(this.fullName + '/dir.c9r') as DirID;
		return this.dirId;
	}

	/**
	 * List directories and files in this directory. Most likely easier to use than using vault's listItems method directly.
	 * @returns Items under this directory
	 */
	async listItems(){
		return await this.vault.listItems(await this.getDirId());
	}

	/**
	 * Create a directory under this directory
	 * @param name Name of the new directory
	 * @param fixedId ID of the directory to create, will be random if not specified
	 * @returns New EncryptedDir object that corresponds to the created directory
	 */
	async createDirectory(name: string, fixedId?: DirID | null){
		return await this.vault.createDirectory(name, await this.getDirId(), fixedId);
	}

	/**
	 * Delete this directory. This object will become invalid, and should never be used again.
	 */
	async deleteDir(){
		await this.vault.deleteDir(this);
	}

	/**
	 * Create a file under this directory
	 * @param name Name of the file
	 * @param content Content of the file
	 * @returns EncryptedFile object that corresponds to the input
	 */
	async createFile(name: string, content: Uint8Array | string){
		return await EncryptedFile.encrypt(this.vault, name, this, content);
	}
}
