import os
import streamlit as st
import pandas as pd
from typing import Dict, Any, List
import sys

# Append parent directories to path for imports
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.data_analyzer import process_file, analyze_relationships, run_profile_report
from src.schema_generator import generate_schema, generate_prompt_for_relationships
from src.ai_client import generate_response

st.set_page_page_config = st.set_page_config(
    page_title="Schema Architect & Relational Analyzer",
    page_icon="🧬",
    layout="wide",
    initial_sidebar_state="expanded"
)

# Custom CSS for polished, modern look
st.markdown("""
<style>
    /* Global styles */
    .reportview-container {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    
    /* Header/Hero Section */
    .hero-container {
        background: linear-gradient(135deg, #1E3A8A 0%, #3B82F6 100%);
        padding: 2.5rem;
        border-radius: 12px;
        color: white;
        margin-bottom: 2rem;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    }
    .hero-title {
        font-size: 2.2rem;
        font-weight: 700;
        margin: 0;
    }
    .hero-subtitle {
        font-size: 1.1rem;
        font-weight: 300;
        opacity: 0.9;
        margin-top: 0.5rem;
    }
    
    /* Card component */
    .custom-card {
        background-color: white;
        padding: 1.5rem;
        border-radius: 8px;
        border: 1px solid #E5E7EB;
        box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05);
        margin-bottom: 1.5rem;
    }
    .custom-card-header {
        font-size: 1.1rem;
        font-weight: 600;
        color: #1F2937;
        margin-bottom: 0.75rem;
        border-bottom: 1px solid #F3F4F6;
        padding-bottom: 0.5rem;
    }
    
    /* Metric pills */
    .metric-badge {
        display: inline-block;
        padding: 0.25rem 0.75rem;
        border-radius: 9999px;
        font-size: 0.75rem;
        font-weight: 600;
        margin-right: 0.5rem;
        margin-bottom: 0.5rem;
    }
    .badge-primary { background-color: #DBEAFE; color: #1E40AF; }
    .badge-success { background-color: #D1FAE5; color: #065F46; }
    .badge-warning { background-color: #FEF3C7; color: #92400E; }
    .badge-info { background-color: #E0F2FE; color: #0369A1; }
    .badge-neutral { background-color: #F3F4F6; color: #374151; }
    
    /* Step indicators */
    .step-container {
        display: flex;
        align-items: center;
        margin-bottom: 1.5rem;
    }
    .step-badge {
        background-color: #3B82F6;
        color: white;
        font-weight: 700;
        border-radius: 50%;
        width: 2rem;
        height: 2rem;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-right: 0.75rem;
    }
    .step-title {
        font-weight: 600;
        font-size: 1.1rem;
        color: #1F2937;
    }
    
    /* Match Card Grid */
    .match-card {
        border-left: 4px solid #10B981;
        background-color: #F9FAFB;
        padding: 1rem;
        border-radius: 0 6px 6px 0;
        margin-bottom: 1rem;
        border-top: 1px solid #E5E7EB;
        border-right: 1px solid #E5E7EB;
        border-bottom: 1px solid #E5E7EB;
    }
    .match-header {
        font-weight: 600;
        color: #065F46;
        display: flex;
        justify-content: space-between;
        margin-bottom: 0.5rem;
    }
    
    /* Code container */
    pre {
        background-color: #F9FAFB !important;
        border: 1px solid #E5E7EB !important;
        border-radius: 6px !important;
        padding: 1rem !important;
    }
</style>
""", unsafe_allow_html=True)

# Application state initialization
if 'raw_data' not in st.session_state:
    st.session_state.raw_data = {}  # filename -> df
if 'processed_data' not in st.session_state:
    st.session_state.processed_data = {}  # filename -> processed details dict
if 'relations' not in st.session_state:
    st.session_state.relations = None
if 'llm_schema' not in st.session_state:
    st.session_state.llm_schema = None
if 'llm_reasoning' not in st.session_state:
    st.session_state.llm_reasoning = None

# Header Hero
st.markdown("""
<div class="hero-container">
    <h1 class="hero-title">🧬 Schema Architect & Relational Analyzer</h1>
    <p class="hero-subtitle">Upload multi-table CSV datasets to auto-detect join relationships, profile statistics, and generate ready-to-use DB schemas via LLM.</p>
</div>
""", unsafe_allow_html=True)

# Sidebar configurations
with st.sidebar:
    st.header("⚙️ Configuration")
    target_dialect = st.selectbox(
        "Target SQL Dialect",
        options=["PostgreSQL", "MySQL", "SQLite", "DuckDB", "MS SQL Server"],
        index=0
    )
    
    model_choice = st.selectbox(
        "AI Reasoning Model",
        options=["gemini-3.5-flash-low", "gemini-1.5-flash", "gemini-1.5-pro"],
        index=0
    )
    
    st.markdown("---")
    st.markdown("### About")
    st.write("This tool automatically profiles tables, executes heuristics for primary/foreign keys, and leverages Google Gemini to output production-grade DDL schema definitions.")

# File upload area
st.markdown("""
<div class="step-container">
    <div class="step-badge">1</div>
    <div class="step-title">Upload CSV Data Files</div>
</div>
""", unsafe_allow_html=True)

uploaded_files = st.file_back_uploader = st.file_uploader(
    "Choose CSV files (Select multiple files to analyze relationships)",
    type=["csv"],
    accept_multiple_files=True
)

# Process Uploaded Files
if uploaded_files:
    # Check for new uploads or files removed
    current_filenames = {file.name for file in uploaded_files}
    existing_filenames = set(st.session_state.raw_data.keys())
    
    # Reset state if the file list changed (to keep it clean)
    if current_filenames != existing_filenames:
        st.session_state.raw_data = {}
        st.session_state.processed_data = {}
        st.session_state.relations = None
        st.session_state.llm_schema = None
        st.session_state.llm_reasoning = None
        
        # Load files into dataframe
        for file in uploaded_files:
            try:
                # Read first few bytes or read fully into memory
                df = pd.read_csv(file)
                st.session_state.raw_data[file.name] = df
                # Process the data (statistics, datatypes, etc.)
                st.session_state.processed_data[file.name] = process_file(df, file.name)
            except Exception as e:
                st.error(f"Error loading {file.name}: {e}")
                
if st.session_state.raw_data:
    # Display status summary
    st.markdown(f"**Uploaded {len(st.session_state.raw_data)} tables:**")
    cols = st.columns(min(len(st.session_state.raw_data), 4))
    for i, (filename, df) in enumerate(st.session_state.raw_data.items()):
        col = cols[i % len(cols)]
        num_rows, num_cols = df.shape
        col.markdown(f"""
        <div class="custom-card">
            <div class="custom-card-header">{filename}</div>
            <span class="metric-badge badge-primary">{num_rows:,} rows</span>
            <span class="metric-badge badge-info">{num_cols} columns</span>
        </div>
        """, unsafe_allow_html=True)
        
    # Analyze Relationships & Generate Schema button
    st.markdown("---")
    st.markdown("""
    <div class="step-container">
        <div class="step-badge">2</div>
        <div class="step-title">Run Relational Analysis & AI Schema Generation</div>
    </div>
    """, unsafe_allow_html=True)
    
    col_btn1, col_btn2 = st.columns([1, 4])
    with col_btn1:
        run_analysis = st.button("Generate Schema & Relations", type="primary", use_container_width=True)
        
    if run_analysis:
        with st.spinner("Analyzing columns, verifying values, and calculating Jaccard similarity..."):
            # Compute relationships using the engine
            st.session_state.relations = analyze_relationships(st.session_state.processed_data)
            
        with st.spinner(f"Querying {model_choice} to generate DDL & constraints..."):
            # Construct the system and user prompts
            prompt_data = generate_prompt_for_relationships(
                st.session_state.processed_data,
                st.session_state.relations,
                dialect=target_dialect
            )
            
            # Generate the response
            success, response = generate_response(
                prompt=prompt_data["prompt"],
                system_instruction=prompt_data["system_instruction"],
                model=model_choice
            )
            
            if success:
                # Parse output to extract schema code and explanations
                parsed_schema = generate_schema(response)
                st.session_state.llm_schema = parsed_schema["schema"]
                st.session_state.llm_reasoning = parsed_schema["explanation"]
                st.success("Analysis and schema generation complete!")
            else:
                st.error(f"Failed to query AI model: {response}")
                
    # Show results if available
    if st.session_state.relations is not None:
        tab1, tab2, tab3 = st.tabs(["📊 Table Relationships", "💾 Generated SQL DDL", "📝 AI Analysis & Rationale"])
        
        with tab1:
            st.subheader("Detected Primary & Foreign Key Candidates")
            
            pks = st.session_state.relations.get("primary_keys", {})
            fks = st.session_state.relations.get("foreign_keys", [])
            
            st.markdown("#### Primary Keys")
            if pks:
                pk_md = ""
                for tbl, col in pks.items():
                    pk_md += f"<span class='metric-badge badge-success'><b>{tbl}</b>.{col}</span> "
                st.markdown(pk_md, unsafe_allow_html=True)
            else:
                st.info("No strong single-column primary key candidate found.")
                
            st.markdown("#### Foreign Key / Join Candidates")
            if fks:
                for fk in fks:
                    left_tbl, left_col = fk["from"]
                    right_tbl, right_col = fk["to"]
                    score = fk["jaccard_similarity"]
                    confidence = "High" if score > 0.8 else "Medium" if score > 0.5 else "Low"
                    badge_class = "badge-success" if confidence == "High" else "badge-warning" if confidence == "Medium" else "badge-neutral"
                    
                    st.markdown(f"""
                    <div class="match-card">
                        <div class="match-header">
                            <span>{left_tbl}.{left_col} ──► {right_tbl}.{right_col}</span>
                            <span class="metric-badge {badge_class}">Confidence: {confidence} ({score:.2f})</span>
                        </div>
                        <div style="font-size: 0.85rem; color: #4B5563;">
                            Detected relationship via column name matching and value overlap (Jaccard Index: {score:.4f}).
                        </div>
                    </div>
                    """, unsafe_allow_html=True)
            else:
                st.info("No foreign key candidates detected between these tables.")
                
        with tab2:
            st.subheader(f"SQL Schema DDL ({target_dialect})")
            if st.session_state.llm_schema:
                st.code(st.session_state.llm_schema, language="sql")
                st.download_button(
                    label="Download SQL Script",
                    data=st.session_state.llm_schema,
                    file_name=f"schema_{target_dialect.lower()}.sql",
                    mime="text/plain"
                )
            else:
                st.warning("No schema code generated.")
                
        with tab3:
            st.subheader("AI Analysis & Reasoning")
            if st.session_state.llm_reasoning:
                st.markdown(st.session_state.llm_reasoning)
            else:
                st.warning("No reasoning explanation generated.")

else:
    st.info("Please upload one or more CSV files in Step 1 to begin.")
