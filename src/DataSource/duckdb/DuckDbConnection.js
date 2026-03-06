import { EventEmitter } from '../../util/event/EventEmitter.js';
import { getDuckDbModule } from './database.js';

export class DuckDbConnection extends EventEmitter {
  
  #duckDbInstance = undefined;
  #physicalConnection = undefined;
  #state = 'unconnected';
  
  constructor(duckDbInstance) {
    super(['beforequery','afterquery']);
    this.#duckDbInstance = duckDbInstance;
  }

  async getPhysicalConnection(){
    if (this.#physicalConnection === undefined) {
      this.#state = 'connecting';
      this.#physicalConnection = await this.#duckDbInstance.connect();
      this.#state = 'connected';
    }
    return this.#physicalConnection;
  }
  
  async prepareStatement(sql){
    const connection = await this.getPhysicalConnection();
    this.#state = 'preparing';
    const preparedStatement = await connection.prepare(sql);
    this.#state = 'prepared';
    return preparedStatement;
  }
  
  getConnectionId(){
    if (this.#physicalConnection === undefined){
      return undefined;
    }
    return this.#physicalConnection._conn;
  }
  
  async query(sql){
    const connection = await this.getPhysicalConnection();
    
    // TODO: allow query to be canceled?
    this.fireEvent('beforequery', {
      physicalConnection: connection,
      sql: sql
    });
    
    this.#state = 'querying';
    const msg = `Executing ${sql} on connection ${this.getConnectionId()}`;
    console.time(msg);
    const result = await connection.query(sql);
    console.timeEnd(msg);
    this.#state = 'queried';
    
    this.fireEvent('afterquery', {
      physicalConnection: connection,
      sql: sql,
      result: result
    });
    
    return result;
  }

  async cancelPendingQuery(){
    if (this.#physicalConnection === undefined){
      return this.#state;
    }
    this.#state = 'canceling';
    try {
      const canceled = await this.#duckDbInstance.cancelPendingQuery(this.#physicalConnection);
      if (canceled) {
        this.#state = 'canceled';
      }
      else {
        this.#state = 'cancelingerror';
      }
    }
    catch(e){
      this.#state = 'cancelingerror';
      console.error('Error encountered while canceling pending queries on connection', this.getConnectionId(), e);
    }
    return this.#state;
  }
  
  registerFile(file, protocol){
    if (! (file instanceof File)){
      throw new Error(`Invalid argument! Need instance of File.`);
    }
    const dataProtocol = protocol || getDuckDbModule().DuckDBDataProtocol.BROWSER_FILEREADER;
    return this.#duckDbInstance.registerFileHandle(
      file.name, 
      file, 
      dataProtocol
    );
  }
 
  copyFileToBuffer(fileName){
    return this.#duckDbInstance.copyFileToBuffer(fileName);
  }
  
  dropFile(fileName){
    return this.#duckDbInstance.dropFile(fileName);
  }
  
  async close(){
    if (this.#physicalConnection){
      try {
        this.#state = 'closing';
        const result = await this.#physicalConnection.close();
        this.#state = 'closed';
        return result;
      } catch (e) {
        console.error('DuckDB connection close failed', e);
        throw e;
      } finally {
        this.#state = 'destroyed';
        this.#physicalConnection = null;
        this.#duckDbInstance = null;
      }
    }
    return null;
  }
  
  async destroy(){
    if (this.#physicalConnection){
      try {
        await this.close();
      } catch (e) {
        console.error('DuckDB connection destroy failed', e);
        throw e;
      }
    }
    this.#state = 'destroyed';
    this.#physicalConnection = null;
  }
 
  getState(){
    return this.#state;
  }
}
