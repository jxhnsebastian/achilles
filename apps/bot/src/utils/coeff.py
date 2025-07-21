import numpy as np
import pandas as pd
import matplotlib.pyplot as plt



## Important Variables for LP Simulation
## Brownian Motion
T  = 1.0/365 # Time measured in 1 year, divide by 365 for daily price path
N  = 1440    # Number of time-steps for brownian motion 
dt = T / N   # Time step
mu = 0.00    # Expected annual return (drift)
sigma = 1.0  # Annualized volatility

## Initial LP Range, Value and Rebalance Conditions 
LP_initial_value = 1000 # Initial value of the LP Pool
tick_spacing = 100 # dictates the width of an lp position, width = 2*(1.0001^tick_spacing) 
imbalance = 0.10 # dictates the imbalance required within the LP pool to trigger a rebalance
fee_rate = 0.0004 # dictates the fees associated with swapping Token A for Token B or vice-versa

def return_price_path(T, N, dt, mu, sigma):
    # Parameters
    T = T  # Total time (1 year), if divided by 12, 1 month. 
    N = N  # Number of time steps
    dt = dt  # Time step
    mu = mu  # Expected annual return (drift)
    sigma = sigma  # Annualized volatility
    
    # Initial condition
    S0 = 100  # Starting price of the asset
    
    # Random component: generate all changes at once
    Z = np.random.normal(0, 1, N)
    
    # Calculate the percentage changes in price
    percentage_changes = (mu - 0.5 * sigma**2) * dt + sigma * np.sqrt(dt) * Z

    # Calculate the price path using the cumulative product of changes
    price_path = np.zeros(N+1)
    price_path[0] = S0
    for i in range(1, N+1):
        price_path[i] = price_path[i-1] * np.exp(percentage_changes[i-1])

    # Convert the arrays into dictionaries
    price_path_dict = {i: price_path[i] for i in range(N+1)}
    
    return price_path_dict


# calculate constant for LP position
def calculate_L(V, P, t):
    return V/((2*np.sqrt(P)-(P + P) / (np.sqrt(P) * (1.0001 ** t))))


# calculate value of LP position
def calculate_V(P, P0, L, t):
    return L*(2*np.sqrt(P)-(P + P0) / (np.sqrt(P0) * (1.0001 ** t)))

# rebalance_lp_position
def rebalance_lp_position(price, lp_position):
    
    if (price<lp_position['p_lower_rebalance'] or 
        price>lp_position['p_upper_rebalance']):
        
        #####
        lp_position['value'] = lp_position['value']*(1-(0.5-lp_position['imbalance'])*lp_position['fee_rate'])
        lp_position['p_0'] = price
        lp_position['p_lower'] = lp_position['p_0']*(1.0001 ** (-lp_position['num_ticks']))
        lp_position['p_upper'] = lp_position['p_0']*(1.0001 ** (lp_position['num_ticks']))
        lp_position['p_lower_rebalance'] = lp_position['p_lower']*(1.0001 ** (lp_position['num_ticks']*lp_position['imbalance']*2))
        lp_position['p_upper_rebalance'] = lp_position['p_upper']*(1.0001 ** (-lp_position['num_ticks']*lp_position['imbalance']*2))
        lp_position['L'] = calculate_L(lp_position['value'], lp_position['p_0'], lp_position['num_ticks'])
        #####
        # print (price, lp_position['value'], "REBALANCE", )
        
    return lp_position

# price_path = brownian motion price path
def simulate_lp_value(price_path, V, t, imbalance, fee_rate):
    
    
    lp_position = {}
    lp_position['value'] = V
    lp_position['price'] = price_path[0]
    lp_position['p_0'] = price_path[0]
    lp_position['num_ticks'] = t 
    lp_position['p_lower'] = lp_position['p_0']*(1.0001 ** (-t))
    lp_position['p_upper'] = lp_position['p_0']*(1.0001 ** (t))
    lp_position['L'] = calculate_L(lp_position['value'], lp_position['p_0'], lp_position['num_ticks'])
    lp_position['p_lower_rebalance'] = lp_position['p_lower']*(1.0001 ** (t*imbalance*2))
    lp_position['p_upper_rebalance'] = lp_position['p_upper']*(1.0001 ** (-t*imbalance*2))
    lp_position['imbalance'] = imbalance
    lp_position['fee_rate'] = fee_rate
    
    simulation = pd.DataFrame([lp_position])
    #simulation = pd.concat([simulation, simulation], ignore_index=True)
    
    
    # print(*lp_position.items(), sep='\n')
    
    for time_step in price_path:
        lp_position['value'] = calculate_V(price_path[time_step], 
                                           lp_position['p_0'], 
                                           lp_position['L'], 
                                           lp_position['num_ticks'])
        
        lp_position['price'] = price_path[time_step]
        # print (price_path[time_step], lp_position['value'])
        
        lp_position = rebalance_lp_position(price_path[time_step], lp_position)
        # print (price_path[time_step], lp_position['value'])
        # print ()
        
        new_row = pd.DataFrame([lp_position])
        simulation = pd.concat([simulation, new_row], ignore_index=True)
        
    
    return simulation
        


price_path = return_price_path(T, N, dt, mu, sigma)

L_decay_columns = ['tick_100', 'tick_200', 'tick_300', 'tick_400', 'tick_500', 
                   'tick_600', 'tick_700', 'tick_800', 'tick_900', 'tick__1000']
L_decay = pd.DataFrame(columns = L_decay_columns)
    
volatility_testing = [0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0]
L_decay_volatility = pd.DataFrame(columns = volatility_testing)

for v in volatility_testing:
    sigma = v
    for i in range(1, 5):
        price_path = return_price_path(T, N, dt, mu, sigma)
        
        simulation_list1 = simulate_lp_value(price_path, LP_initial_value, tick_spacing, imbalance, fee_rate)
        simulation_list2 = simulate_lp_value(price_path, LP_initial_value, tick_spacing*2, imbalance, fee_rate)
        simulation_list3 = simulate_lp_value(price_path, LP_initial_value, tick_spacing*3, imbalance, fee_rate)
        simulation_list4 = simulate_lp_value(price_path, LP_initial_value, tick_spacing*4, imbalance, fee_rate)
        simulation_list5 = simulate_lp_value(price_path, LP_initial_value, tick_spacing*5, imbalance, fee_rate)
        simulation_list6 = simulate_lp_value(price_path, LP_initial_value, tick_spacing*6, imbalance, fee_rate)
        simulation_list7 = simulate_lp_value(price_path, LP_initial_value, tick_spacing*7, imbalance, fee_rate)
        simulation_list8 = simulate_lp_value(price_path, LP_initial_value, tick_spacing*8, imbalance, fee_rate)
        simulation_list9 = simulate_lp_value(price_path, LP_initial_value, tick_spacing*9, imbalance, fee_rate)
        simulation_list10 = simulate_lp_value(price_path, LP_initial_value, tick_spacing*10, imbalance, fee_rate)
        
        print (sigma, round(100*simulation_list1.at[N-1, 'L']/simulation_list1.at[0, 'L'], 2), 
                      round(100*simulation_list2.at[N-1, 'L']/simulation_list2.at[0, 'L'], 2), 
                      round(100*simulation_list3.at[N-1, 'L']/simulation_list3.at[0, 'L'], 2), 
                      round(100*simulation_list4.at[N-1, 'L']/simulation_list4.at[0, 'L'], 2), 
                      round(100*simulation_list5.at[N-1, 'L']/simulation_list5.at[0, 'L'], 2), 
                      round(100*simulation_list6.at[N-1, 'L']/simulation_list6.at[0, 'L'], 2), 
                      round(100*simulation_list7.at[N-1, 'L']/simulation_list7.at[0, 'L'], 2), 
                      round(100*simulation_list8.at[N-1, 'L']/simulation_list8.at[0, 'L'], 2), 
                      round(100*simulation_list9.at[N-1, 'L']/simulation_list9.at[0, 'L'], 2), 
                      round(100*simulation_list10.at[N-1, 'L']/simulation_list10.at[0, 'L'], 2))
        
        L_decay.at[i, 'tick_100'] = round(100*simulation_list1.at[N-1, 'L']/simulation_list1.at[0, 'L'], 2)
        L_decay.at[i, 'tick_200'] = round(100*simulation_list2.at[N-1, 'L']/simulation_list2.at[0, 'L'], 2)
        L_decay.at[i, 'tick_300'] = round(100*simulation_list3.at[N-1, 'L']/simulation_list3.at[0, 'L'], 2)
        L_decay.at[i, 'tick_400'] = round(100*simulation_list4.at[N-1, 'L']/simulation_list4.at[0, 'L'], 2)
        L_decay.at[i, 'tick_500'] = round(100*simulation_list5.at[N-1, 'L']/simulation_list5.at[0, 'L'], 2)
        L_decay.at[i, 'tick_600'] = round(100*simulation_list6.at[N-1, 'L']/simulation_list6.at[0, 'L'], 2)
        L_decay.at[i, 'tick_700'] = round(100*simulation_list7.at[N-1, 'L']/simulation_list7.at[0, 'L'], 2)
        L_decay.at[i, 'tick_800'] = round(100*simulation_list8.at[N-1, 'L']/simulation_list8.at[0, 'L'], 2)
        L_decay.at[i, 'tick_900'] = round(100*simulation_list9.at[N-1, 'L']/simulation_list9.at[0, 'L'], 2)
        L_decay.at[i, 'tick__1000'] = round(100*simulation_list10.at[N-1, 'L']/simulation_list10.at[0, 'L'], 2)
    
    
    L_decay_volatility.at[1, v]  = round(L_decay['tick_100'].mean(), 2)
    L_decay_volatility.at[2, v]  = round(L_decay['tick_200'].mean(), 2)
    L_decay_volatility.at[3, v]  = round(L_decay['tick_300'].mean(), 2)
    L_decay_volatility.at[4, v]  = round(L_decay['tick_400'].mean(), 2)
    L_decay_volatility.at[5, v]  = round(L_decay['tick_500'].mean(), 2)
    L_decay_volatility.at[6, v]  = round(L_decay['tick_600'].mean(), 2)
    L_decay_volatility.at[7, v]  = round(L_decay['tick_700'].mean(), 2)
    L_decay_volatility.at[8, v]  = round(L_decay['tick_800'].mean(), 2)
    L_decay_volatility.at[9, v]  = round(L_decay['tick_900'].mean(), 2)
    L_decay_volatility.at[10, v] = round(L_decay['tick__1000'].mean(), 2)
    
    
    print(round(L_decay['tick_100'].mean(), 2),
          round(L_decay['tick_200'].mean(), 2),
          round(L_decay['tick_300'].mean(), 2),
          round(L_decay['tick_400'].mean(), 2),
          round(L_decay['tick_500'].mean(), 2),
          round(L_decay['tick_600'].mean(), 2),
          round(L_decay['tick_700'].mean(), 2),
          round(L_decay['tick_800'].mean(), 2),
          round(L_decay['tick_900'].mean(), 2),
          round(L_decay['tick__1000'].mean(), 2))
    print()



# Simulation 

# Define inputs - Value, Current price, lower tick, higher tick, prices for rebalancing
# Return L (contract for liqudity)
# Now we have a LP Value object, where we can update its value after every price movement
# simulate price movements and rebalance anytime price crosses 'price for rebalancing'
# Value for new pool = define inputs, truncate V by fee rate, and then return a new L
# rinse and repeat


