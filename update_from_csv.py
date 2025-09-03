import sqlite3
import json
import sys

def update_responsibles_from_json(db_path, json_path):
    """
    Atualiza o campo 'nome_responsavel' na tabela Clientes_Eventos
    usando dados de um arquivo JSON. A atualização só ocorre se o campo
    'nome_responsavel' no banco de dados estiver vazio.

    Args:
        db_path (str): Caminho para o banco de dados SQLite.
        json_path (str): Caminho para o arquivo JSON de entrada.
    """
    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"ERRO: O arquivo JSON '{json_path}' não foi encontrado.")
        sys.exit(1)
    except json.JSONDecodeError:
        print(f"ERRO: O arquivo '{json_path}' não é um JSON válido.")
        sys.exit(1)

    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()

        updated_clients = []
        
        print("Iniciando a busca por responsáveis no arquivo JSON...")

        # Itera sobre cada entrada no arquivo JSON
        for entry in data:
            client_data = entry.get('cliente', {})
            doc_norm_json = client_data.get('documento')
            responsavel_json = client_data.get('nome_responsavel')
            razao_social_json = client_data.get('nome_razao_social_oficial', client_data.get('nome_razao_social'))

            # Pula se não houver documento ou responsável no JSON
            if not doc_norm_json or not responsavel_json:
                continue

            # Tenta atualizar o banco de dados
            # A query só atualiza se o nome_responsavel for nulo ou vazio
            cursor.execute("""
                UPDATE Clientes_Eventos
                SET nome_responsavel = ?
                WHERE documento_norm = ? AND (nome_responsavel IS NULL OR nome_responsavel = '')
            """, (responsavel_json, doc_norm_json))

            # Se uma linha foi afetada, a atualização ocorreu
            if cursor.rowcount > 0:
                updated_clients.append(f"- {razao_social_json} (Documento: {doc_norm_json})")
        
        # Salva (comita) as alterações no banco
        conn.commit()
        print("Processo concluído.")

        # --- Relatório Final ---
        print("\n--- Relatório de Atualização de Responsáveis ---")
        if updated_clients:
            print(f"Foram atualizados {len(updated_clients)} clientes com o nome do responsável:")
            for client in updated_clients:
                print(client)
        else:
            print("Nenhum cliente com nome de responsável em branco foi encontrado no arquivo JSON.")

    except sqlite3.Error as e:
        print(f"ERRO de banco de dados: {e}")
        if conn:
            conn.rollback()
    except Exception as e:
        print(f"Ocorreu um erro inesperado: {e}")
    finally:
        if conn:
            conn.close()

# --- INSTRUÇÕES DE USO NA SUA VM ---
# 1. Faça um backup do seu banco de dados por segurança:
#    cp sistemacipt.db sistemacipt.db.bkp_before_json
#
# 2. Suba este arquivo (update_from_json.py) e o arquivo 
#    'dados_prontos_para_importar (1).json' para a mesma pasta
#    onde está o seu banco 'sistemacipt.db'.
#
# 3. Execute o script no terminal com o comando:
#    python3 update_from_json.py

if __name__ == '__main__':
    DATABASE_FILE = 'sistemacipt.db'
    JSON_FILE = 'dados_prontos_para_importar (1).json'
    
    update_responsibles_from_json(DATABASE_FILE, JSON_FILE)
