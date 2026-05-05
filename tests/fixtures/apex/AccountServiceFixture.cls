/**
 * AccountServiceFixture
 *
 * Realistic Apex test fixture used by parser tests. Exercises the Apex
 * grammar features that real Salesforce projects rely on:
 *
 *   - Modifiers: public, private, global, static, virtual, with sharing
 *   - JavaDoc-style block comments preceding declarations
 *   - Annotations: @AuraEnabled, @TestVisible, @InvocableMethod
 *   - Inner classes and inner enums
 *   - Custom exceptions (extends Exception)
 *   - Inline SOQL ([SELECT ... FROM ...])
 *   - DML statements (insert, update, Database.SaveResult)
 *   - try/catch blocks with typed exceptions
 *   - Constructor overloads
 *
 * This fixture is intentionally not part of the production source tree;
 * it lives under tests/fixtures/apex/ and is loaded via fs.readFileSync.
 */
public with sharing class AccountServiceFixture implements Schedulable, Database.Batchable<sObject> {

    // ---- Constants ----------------------------------------------------------

    public static final String DEFAULT_NAME = 'Untitled';
    public static final Integer MAX_RETRY = 3;
    private static final Set<String> ALLOWED_TYPES = new Set<String>{
        'Customer', 'Partner', 'Prospect'
    };

    // ---- State --------------------------------------------------------------

    private List<Account> pendingAccounts;
    private Integer retryCount;

    // ---- Constructors -------------------------------------------------------

    /**
     * Default constructor used by the standard scheduling entry point.
     */
    public AccountServiceFixture() {
        this.pendingAccounts = new List<Account>();
        this.retryCount = 0;
    }

    /**
     * Constructor that pre-loads accounts from a list of IDs, bulkified
     * to a single SOQL query regardless of the input size.
     */
    public AccountServiceFixture(Set<Id> accountIds) {
        this();
        if (accountIds != null && !accountIds.isEmpty()) {
            this.pendingAccounts = [
                SELECT Id, Name, Type, Industry
                FROM Account
                WHERE Id IN :accountIds
                WITH SECURITY_ENFORCED
            ];
        }
    }

    // ---- Public API ---------------------------------------------------------

    /**
     * Creates a new Account with the given name. Returns the inserted record
     * with Id populated.
     *
     * @param name  The account name. Falls back to DEFAULT_NAME if blank.
     * @return      The persisted Account.
     */
    @AuraEnabled
    public static Account createAccount(String name) {
        String safeName = String.isBlank(name) ? DEFAULT_NAME : name;
        Account a = new Account(Name = safeName, Type = 'Customer');
        try {
            insert a;
        } catch (DmlException e) {
            throw new AccountServiceException(
                'Failed to insert account: ' + e.getMessage()
            );
        }
        return a;
    }

    /**
     * Updates the Type of all accounts owned by the running user.
     */
    @AuraEnabled
    public static Integer updateOwnedAccountTypes(String newType) {
        if (!ALLOWED_TYPES.contains(newType)) {
            throw new AccountServiceException('Invalid type: ' + newType);
        }
        List<Account> owned = [
            SELECT Id, Type
            FROM Account
            WHERE OwnerId = :UserInfo.getUserId()
        ];
        for (Account a : owned) {
            a.Type = newType;
        }
        Database.SaveResult[] results = Database.update(owned, false);
        Integer successes = 0;
        for (Database.SaveResult r : results) {
            if (r.isSuccess()) {
                successes++;
            }
        }
        return successes;
    }

    /**
     * Invocable entry point used by Flow / Process Builder.
     */
    @InvocableMethod(label='Tag Accounts' description='Adds a tag to a list of accounts')
    public static List<TagResult> tagAccounts(List<TagRequest> requests) {
        List<TagResult> output = new List<TagResult>();
        for (TagRequest req : requests) {
            output.add(applyTag(req));
        }
        return output;
    }

    @TestVisible
    private static TagResult applyTag(TagRequest req) {
        TagResult result = new TagResult();
        result.accountId = req.accountId;
        result.success = true;
        return result;
    }

    // ---- Schedulable / Batchable -------------------------------------------

    public void execute(SchedulableContext sc) {
        Database.executeBatch(this, 200);
    }

    public Database.QueryLocator start(Database.BatchableContext bc) {
        return Database.getQueryLocator(
            'SELECT Id, Name FROM Account WHERE Type = \'Prospect\''
        );
    }

    public void execute(Database.BatchableContext bc, List<Account> scope) {
        for (Account a : scope) {
            a.Type = 'Customer';
        }
        update scope;
    }

    public void finish(Database.BatchableContext bc) {
        // Hook for downstream notifications. Intentionally empty.
    }

    // ---- Inner types --------------------------------------------------------

    /**
     * Status enum used by reporting jobs.
     */
    public enum ProcessingStatus {
        PENDING,
        IN_PROGRESS,
        COMPLETED,
        FAILED
    }

    /**
     * Inner DTO mapped to the Invocable inputs.
     */
    public class TagRequest {
        @InvocableVariable(required=true)
        public Id accountId;
        @InvocableVariable(required=true)
        public String tag;
    }

    /**
     * Inner DTO mapped to the Invocable outputs.
     */
    public class TagResult {
        @InvocableVariable
        public Id accountId;
        @InvocableVariable
        public Boolean success;
    }

    /**
     * Inner helper that wraps an Account with display metadata.
     */
    public virtual class AccountWrapper {
        public Account record;
        public String displayName;

        public AccountWrapper(Account a) {
            this.record = a;
            this.displayName = a.Name + ' (' + a.Type + ')';
        }

        public virtual String describe() {
            return this.displayName;
        }
    }

    /**
     * Custom exception type for service-level failures.
     */
    public class AccountServiceException extends Exception {}
}
