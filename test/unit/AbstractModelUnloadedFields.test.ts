import AbstractModel from "../../src/models/AbstractModel";
import {UnloadedFieldError} from "../../src/errors/UnloadedFieldError";

class AccountModel extends AbstractModel {
    protected username: string = '';
    protected visibility: string = 'public';
    protected tags: string[] = [];

    public getUsername(): string {
        return this.username;
    }

    public getVisibility(): string {
        return this.visibility;
    }

    public setVisibility(visibility: string): void {
        this.visibility = visibility;
    }

    public getTags(): string[] {
        return this.tags;
    }
}

describe('AbstractModel - pole niewczytane z bazy nie udaje wartości', () => {
    it('odczyt pola, którego zapytanie nie wybrało, rzuca UnloadedFieldError z nazwą modelu i pola', () => {
        const account: AccountModel = new AccountModel();
        account.hydrateModel({id: 1, username: 'anna'}, 1);

        expect(account.getUsername()).toBe('anna');
        expect(() => account.getVisibility()).toThrow(UnloadedFieldError);
        expect(() => account.getVisibility()).toThrow('AccountModel.visibility');
    });

    it('wczytana wartość NULL jest wczytana - zwraca null, nie rzuca', () => {
        const account: AccountModel = new AccountModel();
        account.hydrateModel({id: 1, username: 'anna', visibility: null, tags: null}, 1);

        expect(account.getVisibility()).toBeNull();
        expect(account.getTags()).toBeNull();
    });

    it('przypisanie w kodzie wczytuje pole', () => {
        const account: AccountModel = new AccountModel();
        account.hydrateModel({id: 1, username: 'anna'}, 1);

        account.setVisibility('trusted');

        expect(account.getVisibility()).toBe('trusted');
    });

    it('toJSON i getChangedData pomijają pola niewczytane', () => {
        const account: AccountModel = new AccountModel();
        account.hydrateModel({id: 1, username: 'anna'}, 1);

        expect(account.toJSON()).toEqual({username: 'anna'});
        expect(account.getChangedData()).toEqual({});
        account.setVisibility('members');
        expect(account.getChangedData()).toEqual({visibility: 'members'});
    });

    it('kolejna hydratacja dociąga brakujące pole', () => {
        const account: AccountModel = new AccountModel();
        account.hydrateModel({id: 1, username: 'anna'}, 1);
        account.hydrateModel({visibility: 'members'});

        expect(account.getVisibility()).toBe('members');
        expect(account.getUsername()).toBe('anna');
    });

    it('model zbudowany w kodzie ma wartości domyślne i zapisuje wszystkie pola', () => {
        const account: AccountModel = new AccountModel();

        expect(account.getVisibility()).toBe('public');
        expect(account.toJSON()).toEqual({username: '', visibility: 'public', tags: []});
    });

    it('rozpakowanie obiektu i porównanie nie dotykają pól niewczytanych', () => {
        const account: AccountModel = new AccountModel();
        account.hydrateModel({id: 1, username: 'anna'}, 1);

        expect(() => ({...account})).not.toThrow();
        expect(() => JSON.stringify(account)).not.toThrow();
    });
});
